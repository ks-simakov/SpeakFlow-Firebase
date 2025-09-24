import {setGlobalOptions} from "firebase-functions";
import {HttpsError} from "firebase-functions/v1/https";
import {onCall, CallableRequest} from "firebase-functions/v2/https";
import {initializeApp} from "firebase-admin/app";
import {getFirestore, Firestore} from "firebase-admin/firestore";

setGlobalOptions({region: "europe-west1", maxInstances: 10});
initializeApp();

const db: Firestore = getFirestore();

type LessonTemplate = {
	title: string;
	subtitle: string;
	category: string;
	estimatedDurationSeconds: number;
	isLocked: boolean;
	requiredPersonalizationFields: string[];
	promptTemplateId: string;
};

type PromptTemplate = {
	userPrompt: string;
	systemPrompt?: string;
	chunkingStrategy?: {type?: string; maxLength?: number};
};

type PersonalizationMap = Record<string, string>;

type GenerateScriptResponse = {
	lessonId: string;
	title: string;
	fullText: string;
	chunks: Array<{order: number; text: string}>;
};

function requireAuth<T>(request: CallableRequest<T>): string {
	const uid = request.auth?.uid;
	if (!uid) {
		throw new HttpsError("unauthenticated", "Anonymous Firebase Authentication is required.");
	}
	return uid;
}

function parseGenerateScriptPayload(data: unknown): {
	lessonId: string;
	languageCode: string;
	targetLevel: string;
	personalization: PersonalizationMap;
} {
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		throw new HttpsError("invalid-argument", "Request payload must be an object.");
	}
	const payload = data as Record<string, unknown>;
	const lessonId = expectString(payload.lessonId, "lessonId");
	const languageCode = expectString(payload.languageCode, "languageCode");
	const targetLevel = expectString(payload.targetLevel, "targetLevel");
	const personalizationValue = payload.personalization;
	if (personalizationValue === null || typeof personalizationValue !== "object" || Array.isArray(personalizationValue)) {
		throw new HttpsError("invalid-argument", "personalization must be an object of string values.");
	}
	const personalizationEntries = Object.entries(personalizationValue);
	const personalization: PersonalizationMap = {};
	for (const [key, value] of personalizationEntries) {
		if (typeof value !== "string") {
			throw new HttpsError("invalid-argument", `personalization value for ${key} must be a string.`);
		}
		personalization[key] = value.trim();
	}
	return {lessonId, languageCode: languageCode.trim(), targetLevel: targetLevel.trim(), personalization};
}

function expectString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new HttpsError("invalid-argument", `${field} must be a non-empty string.`);
	}
	return value.trim();
}

function ensurePersonalizationCoverage(requiredFields: string[], personalization: PersonalizationMap): void {
	const missing = requiredFields.filter((field) => !personalization[field]);
	if (missing.length > 0) {
		throw new HttpsError(
			"invalid-argument",
			`Missing personalization values for: ${missing.join(", ")}.`,
		);
	}
}

function renderTemplate(template: string, replacements: Record<string, string>): string {
	return template.replace(/{{\s*([\w.]+)\s*}}/g, (match, key) => {
		const replacement = replacements[key];
		return replacement !== undefined ? replacement : match;
	});
}

function humanizeKey(key: string): string {
	return key.replace(/_/g, " ").replace(/\b\w/g, (segment) => segment.toUpperCase()).trim();
}

function buildScript(params: {
	lessonId: string;
	lesson: LessonTemplate;
	prompt: PromptTemplate;
	languageCode: string;
	targetLevel: string;
	personalization: PersonalizationMap;
	uid: string;
}): GenerateScriptResponse {
	const {lessonId, lesson, prompt, languageCode, targetLevel, personalization, uid} = params;
	const personalizationSummary = Object.keys(personalization)
		.sort()
		.map((key) => `${humanizeKey(key)}: ${personalization[key]}`)
		.join("; ");
	const replacements: Record<string, string> = {
		lesson_title: lesson.title,
		lesson_subtitle: lesson.subtitle,
		language_code: languageCode,
		target_level: targetLevel,
		learner_uid: uid,
		personalization_summary: personalizationSummary,
		...personalization,
	};
	const promptPreview = renderTemplate(prompt.userPrompt, replacements);
	const sentences: string[] = [
		`Let's practice the lesson "${lesson.title}" at ${targetLevel} level.`,
		personalizationSummary ? `Personalization: ${personalizationSummary}.` : "",
		`Respond in ${languageCode} and keep the tone encouraging.`,
		promptPreview ? `Prompt guidance: ${promptPreview}` : "",
	];
	const filtered = sentences.filter((sentence) => sentence.trim().length > 0);
	const fullText = filtered.join(" ");
	const chunks = filtered.map((text, index) => ({order: index, text}));
	return {
		lessonId,
		title: lesson.title,
		fullText,
		chunks,
	};
}

export const lessonsList = onCall({}, async (request) => {
	requireAuth(request);
	const snapshot = await db
		.collection("lessonTemplates")
		.orderBy("category")
		.orderBy("title")
		.get();
	const lessons = snapshot.docs.map((doc) => {
		const data = doc.data() as LessonTemplate;
		return {id: doc.id, ...data};
	});
	return {lessons};
});

export const generateScript = onCall({}, async (request) => {
	const uid = requireAuth(request);
	const {lessonId, languageCode, targetLevel, personalization} = parseGenerateScriptPayload(request.data);
	const lessonSnapshot = await db.collection("lessonTemplates").doc(lessonId).get();
	if (!lessonSnapshot.exists) {
		throw new HttpsError("not-found", `Lesson ${lessonId} does not exist.`);
	}
	const lessonData = lessonSnapshot.data() as LessonTemplate;
	const requiredFields = Array.isArray(lessonData.requiredPersonalizationFields) ? lessonData.requiredPersonalizationFields : [];
	ensurePersonalizationCoverage(requiredFields, personalization);
	const promptSnapshot = await db.collection("promptTemplates").doc(lessonData.promptTemplateId).get();
	if (!promptSnapshot.exists) {
		throw new HttpsError(
			"failed-precondition",
			`Prompt template ${lessonData.promptTemplateId} referenced by lesson ${lessonId} is missing.`,
		);
	}
	const promptData = promptSnapshot.data() as PromptTemplate;
	const response = buildScript({
		lessonId,
		lesson: lessonData,
		prompt: promptData,
		languageCode,
		targetLevel,
		personalization,
		uid,
	});
	return response;
});
