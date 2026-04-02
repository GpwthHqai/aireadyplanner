/**
 * Vercel Serverless API Route: AI Readiness Diagnostic Transcript Processor
 *
 * Receives a transcript from a recorded diagnostic session and uses the Anthropic API
 * to extract structured answers to diagnostic questions.
 *
 * REQUIRED ENVIRONMENT VARIABLES (set in Vercel Dashboard → Project Settings → Environment Variables):
 *
 * - ANTHROPIC_API_KEY: Your Anthropic API key
 *   Get from: https://console.anthropic.com/keys
 */

const Anthropic = require("@anthropic-ai/sdk");

export default async function handler(req, res) {
  // CORS headers
  const origin = req.headers.origin || "";
  const allowedOrigins = [
    "https://aireadyplanner.com",
    "https://www.aireadyplanner.com",
    "http://localhost:3000",
    "http://localhost:5173",
  ];

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { transcript, questions } = req.body;

    if (!transcript || !questions || !Array.isArray(questions)) {
      return res.status(400).json({
        error: "Missing required fields: transcript, questions",
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("ANTHROPIC_API_KEY not configured");
      return res.status(500).json({
        error: "API not configured. Please set ANTHROPIC_API_KEY environment variable.",
      });
    }

    const client = new Anthropic();

    // Build question list for Claude
    const questionsList = questions
      .map((q) => `- [${q.id}] ${q.text}`)
      .join("\n");

    const systemPrompt = `You are an expert diagnostic analyst for AI readiness assessments in communications organizations.
Your task is to carefully read a diagnostic session transcript and extract factual answers to specific diagnostic questions.

CRITICAL RULES:
1. Extract ONLY what the client actually said in the transcript
2. If a question is not discussed, answer with "Not discussed"
3. Be factual and concise - do not synthesize, interpret, or assume
4. Preserve the client's own words where possible
5. If multiple parts of the transcript relate to a question, synthesize into a single coherent answer
6. Do not add external knowledge or assumptions

Output format ONLY: valid JSON object with question IDs as keys and extracted answers as values.
Example:
{
  "q1-1": "The client said...",
  "q1-2": "Not discussed",
  "q2-1": "..."
}`;

    const userPrompt = `Here are the diagnostic questions to extract answers for:

${questionsList}

Now read this transcript and extract the answers:

---TRANSCRIPT START---
${transcript}
---TRANSCRIPT END---

Return a JSON object mapping each question ID to the extracted answer. Use "Not discussed" if the topic wasn't covered.`;

    const message = await client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 4000,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: userPrompt,
        },
      ],
    });

    // Extract the response text
    const responseText =
      message.content[0].type === "text" ? message.content[0].text : "";

    // Parse JSON from response
    let answers = {};
    try {
      // Try to find JSON in the response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        answers = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("No JSON found in response");
      }
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      console.error("Response text:", responseText);
      return res.status(500).json({
        error: "Failed to parse API response",
        details: parseError.message,
      });
    }

    return res.status(200).json({
      success: true,
      answers,
      transcriptLength: transcript.length,
      questionsProcessed: questions.length,
    });
  } catch (error) {
    console.error("Transcript processing error:", error);

    if (error.status === 401) {
      return res.status(401).json({
        error: "Authentication failed. Check ANTHROPIC_API_KEY.",
      });
    }

    if (error.status === 429) {
      return res.status(429).json({
        error: "Rate limited. Please try again in a moment.",
      });
    }

    return res.status(500).json({
      error: "Failed to process transcript",
      message: error.message,
    });
  }
}
