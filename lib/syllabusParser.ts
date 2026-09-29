import { groq, GENERATION_MODEL } from "@/lib/groq";
import { extractSyllabusFromImage } from "@/lib/visionParser";
import pdfParse from "pdf-parse-fork";

export interface ParsedSyllabus {
  title: string;
  gradeLevel: string;
  subject: string;
  topics: string[];
  summary?: string;
}

// Heuristic fallback parser when AI is unavailable or offline
export function parseSyllabusHeuristic(rawText: string): ParsedSyllabus {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let detectedGrade = "5th Grade";
  let detectedSubject = "General Science & Math";
  let title = "Uploaded Syllabus";
  const topics: string[] = [];

  const gradeMatch = rawText.match(/(?:grade|class|standard|year)\s*([0-9]{1,2}|kindergarten|k-[0-9]{1,2})/i);
  if (gradeMatch) {
    const num = gradeMatch[1];
    detectedGrade = num.toLowerCase().includes("kindergarten") ? "Kindergarten" : `${num}th Grade`;
  } else if (/sat|act|ap\s+|college/i.test(rawText)) {
    detectedGrade = "High School / AP";
  }

  const subjects = ["Math", "Physics", "Chemistry", "Biology", "Science", "History", "Geography", "Computer Science", "Coding", "English", "English Language Arts", "Reading", "ELA", "Economics"];
  for (const s of subjects) {
    if (new RegExp(`\\b${s}\\b`, "i").test(rawText)) {
      detectedSubject = s;
      break;
    }
  }

  for (const line of lines) {
    // Check if line looks like a chapter/topic/unit/bullet
    const cleaned = line
      .replace(/^[\d+.)\-*•–—\t ]+/, "")
      .replace(/^(unit|chapter|module|section|topic|week)\s*\d*[:\-.]?\s*/i, "")
      .trim();

    if (cleaned.length >= 3 && cleaned.length <= 100 && !cleaned.toLowerCase().startsWith("page") && !cleaned.toLowerCase().includes("copyright")) {
      // Avoid duplicate or overly verbose sentences
      if (!topics.includes(cleaned) && topics.length < 25) {
        topics.push(cleaned);
      }
    }
  }

  if (lines.length > 0 && lines[0].length < 80) {
    title = lines[0].replace(/^[#* \t]+/, "");
  } else if (topics.length > 0) {
    title = `${detectedSubject}: ${topics[0]}`;
  }

  return {
    title: title || "Custom Syllabus Pack",
    gradeLevel: detectedGrade,
    subject: detectedSubject,
    topics: topics.length > 0 ? topics.slice(0, 15) : ["Core Concepts", "Foundational Principles", "Practical Applications"],
    summary: `Extracted ${topics.length} topics from syllabus text.`,
  };
}

// AI Parser for Text & PDF content
export async function parseSyllabusWithAI(text: string, apiKey?: string): Promise<ParsedSyllabus> {
  const activeKey = apiKey || process.env.GROQ_API_KEY;

  if (activeKey && activeKey !== "your-groq-api-key-here") {
    try {
      const prompt = `You are an expert curriculum director. Analyze the following syllabus / curriculum content and extract structured course metadata and topic breakdowns.

Syllabus Content:
"""
${text.slice(0, 8000)}
"""

Extract and return ONLY a JSON object with this exact schema:
{
  "title": "A concise, descriptive course or unit title (e.g. Grade 8 Physical Science or AP Calculus BC)",
  "gradeLevel": "Target grade level (e.g. 5th Grade, 8th Grade, 10th Grade, SAT/ACT, College)",
  "subject": "Main academic subject (e.g. Math, Science, Physics, Chemistry, Biology, History, English, Coding)",
  "topics": [
    "Topic 1 (clear, specific learning concept)",
    "Topic 2",
    "Topic 3",
    "..."
  ],
  "summary": "Brief 1-2 sentence overview of the syllabus"
}
Ensure there are between 3 and 12 distinct, actionable topics for multiple choice question generation.`;

      const completion = await groq.chat.completions.create({
        model: GENERATION_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        response_format: { type: "json_object" },
      });

      const content = completion.choices[0]?.message?.content;
      if (content) {
        const parsed = JSON.parse(content);
        if (parsed.title && Array.isArray(parsed.topics) && parsed.topics.length > 0) {
          return {
            title: parsed.title,
            gradeLevel: parsed.gradeLevel || "5th Grade",
            subject: parsed.subject || "General Science",
            topics: parsed.topics.map((t: string) => String(t).trim()).filter(Boolean),
            summary: parsed.summary,
          };
        }
      }
    } catch (err) {
      console.warn("Groq syllabus text parsing failed, using fallback heuristic:", err);
    }
  }

  return parseSyllabusHeuristic(text);
}

// AI Vision Parser for Image Uploads (scanned syllabus, whiteboard photo, textbook page)
export async function parseSyllabusFromImage(
  imageBase64: string,
  mimeType: string = "image/jpeg",
  apiKey?: string
): Promise<ParsedSyllabus> {
  // Delegate directly to universal vision parser (Gemini 2.0 Flash / OpenAI)
  const result = await extractSyllabusFromImage(imageBase64, mimeType, apiKey);
  return {
    title: result.title,
    gradeLevel: result.gradeLevel,
    subject: result.subject,
    topics: result.topics,
    summary: result.summary,
  };
}

// Universal PDF extractor
export async function extractTextFromPDFBuffer(buffer: Buffer): Promise<string> {
  try {
    const data = await pdfParse(buffer);
    return data.text || "";
  } catch (err) {
    console.warn("PDF extraction error:", err);
    return "";
  }
}
