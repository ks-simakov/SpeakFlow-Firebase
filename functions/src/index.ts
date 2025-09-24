import {setGlobalOptions} from "firebase-functions";
import {HttpsError} from "firebase-functions/v1/https";
import {onCall, CallableRequest} from "firebase-functions/v2/https";
import {initializeApp} from "firebase-admin/app";
import {getFirestore, Firestore} from "firebase-admin/firestore";
import {defineSecret} from "firebase-functions/params";
import OpenAI from "openai";

setGlobalOptions({region: "europe-west1", maxInstances: 10});
initializeApp();

const db: Firestore = getFirestore();
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

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

async function buildScript(params: {
	lessonId: string;
	lesson: LessonTemplate;
	prompt: PromptTemplate;
	languageCode: string;
	targetLevel: string;
	personalization: PersonalizationMap;
	uid: string;
	openai: OpenAI;
}): Promise<GenerateScriptResponse> {
	const {lessonId, lesson, prompt, languageCode, targetLevel, personalization, uid, openai} = params;
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
	const baseSystemPrompt = [
		"You are an educational speech coach generating structured lesson scripts for language learners.",
		"Keep the tone encouraging and empathetic while staying concise and conversational.",
		"Respond using only JSON that matches the provided schema and avoid Markdown or prose outside the JSON body.",
	];
	const chunkingStrategy = prompt.chunkingStrategy ?? {};
	const chunkingInstructions = chunkingStrategy.maxLength
		? `Split the script into sequential chunks where each chunk is at most ${chunkingStrategy.maxLength} characters.`
		: "Split the script into sequential, conversational chunks that cover the full script.";
	const systemSegments: string[] = [...baseSystemPrompt, chunkingInstructions];
	const renderedSystemPrompt = prompt.systemPrompt ? renderTemplate(prompt.systemPrompt, replacements) : "";
	if (renderedSystemPrompt) {
		systemSegments.push(renderedSystemPrompt);
	}
	const renderedUserPrompt = renderTemplate(prompt.userPrompt, replacements);
	const learnerContext = [
		`Lesson Title: ${lesson.title}`,
		`Lesson Subtitle: ${lesson.subtitle}`,
		`Target Level: ${targetLevel}`,
		`Language Code: ${languageCode}`,
		personalizationSummary ? `Personalization: ${personalizationSummary}` : "",
		`Required Personalization Fields: ${lesson.requiredPersonalizationFields?.join(", ") ?? "None"}`,
		`Prompt Guidance: ${renderedUserPrompt}`,
		chunkingStrategy.type ? `Chunking Strategy: ${chunkingStrategy.type}` : "",
	];
	const schema = {
		type: "object",
		additionalProperties: false,
		properties: {
			fullText: {
				type: "string",
				description: "The complete narrative of the lesson script in the requested language.",
			},
			chunks: {
				type: "array",
				description: "Sequential speaking chunks covering the full script.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						order: {type: "integer", minimum: 0},
						text: {type: "string"},
					},
					required: ["order", "text"],
				},
			},
		},
		required: ["fullText", "chunks"],
	};
	try {
		const response = await openai.responses.create({
			model: "gpt-4.1-mini",
			input: [
				{role: "system", content: systemSegments.filter((segment) => segment.trim().length > 0).join("\n")},
				{role: "user", content: learnerContext.filter((segment) => segment.trim().length > 0).join("\n")},
			],
			text: {
				format: {
					type: "json_schema",
					name: "lesson_script_response",
					schema,
				},
			},
			max_output_tokens: 2048,
		});
		const payload = response.output_text?.trim();
		if (!payload) {
			throw new HttpsError("internal", "OpenAI returned an empty response.");
		}
		let parsed: {fullText?: unknown; chunks?: Array<{order?: unknown; text?: unknown}>} = {};
		try {
			parsed = JSON.parse(payload);
		} catch (parseError) {
			throw new HttpsError("internal", "OpenAI response could not be parsed as JSON.");
		}
		if (typeof parsed.fullText !== "string" || !Array.isArray(parsed.chunks)) {
			throw new HttpsError("internal", "OpenAI response was missing required fields.");
		}
		const sanitizedChunks = parsed.chunks
			.map((chunk) => ({
				order: typeof chunk.order === "number" ? chunk.order : Number(chunk.order),
				text: typeof chunk.text === "string" ? chunk.text.trim() : "",
			}))
			.filter((chunk) => Number.isFinite(chunk.order) && chunk.text.length > 0)
			.sort((a, b) => a.order - b.order)
			.map((chunk, index) => ({order: index, text: chunk.text}));
		if (sanitizedChunks.length === 0) {
			throw new HttpsError("internal", "OpenAI response did not include any usable chunks.");
		}
		const fullText = parsed.fullText.trim().length > 0 ? parsed.fullText.trim() : sanitizedChunks.map((chunk) => chunk.text).join(" ");
		return {
			lessonId,
			title: lesson.title,
			fullText,
			chunks: sanitizedChunks,
		};
	} catch (error) {
		if (error instanceof HttpsError) {
			throw error;
		}
		throw new HttpsError("internal", "Failed to generate lesson script with OpenAI.");
	}
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

export const generateScript = onCall({secrets: [OPENAI_API_KEY]}, async (request) => {
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
	let openai: OpenAI;
	try {
		openai = new OpenAI({apiKey: OPENAI_API_KEY.value()});
	} catch (error) {
		throw new HttpsError("failed-precondition", "OpenAI API key is not configured.");
	}
	const response = await buildScript({
		lessonId,
		lesson: lessonData,
		prompt: promptData,
		languageCode,
		targetLevel,
		personalization,
		uid,
		openai,
	});
	return response;
});
