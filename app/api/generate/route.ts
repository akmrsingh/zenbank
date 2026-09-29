import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import Groq from "groq-sdk";
import { groq, PRIMARY_GENERATION_MODEL, SECONDARY_GENERATION_MODEL } from "@/lib/groq";
import { generateCurriculumQuestions } from "@/lib/fallbackGenerator";
import { shuffleMcqOptions } from "@/lib/shuffle";
import { filterDuplicates, isDuplicate, normalizeQuestionText } from "@/lib/deduplication";

export const dynamic = "force-dynamic";

function getGradeVariants(grade: string): string[] {
  const g = (grade || "").toLowerCase();
  if (g.includes("5") || g.includes("fifth")) return ["5th Grade", "5th", "Grade 5", "Fifth Grade", "Grade 5th"];
  if (g.includes("4") || g.includes("fourth")) return ["4th Grade", "4th", "Grade 4", "Fourth Grade"];
  if (g.includes("3") || g.includes("third")) return ["3rd Grade", "3rd", "Grade 3", "Third Grade"];
  if (g.includes("2") || g.includes("second")) return ["2nd Grade", "2nd", "Grade 2", "Second Grade"];
  if (g.includes("1") || g.includes("first")) return ["1st Grade", "1st", "Grade 1", "First Grade"];
  if (g.includes("k") || g.includes("kinder")) return ["Kindergarten", "K", "Kinder"];
  return [grade];
}

function getSubjectVariants(subj: string): string[] {
  const s = (subj || "").toLowerCase();
  if (s.includes("math")) return ["Math", "Mathematics", "math", "mathematics"];
  if (s.includes("social") || s.includes("history") || s.includes("civic")) return ["Social Studies", "Social Science", "History", "Civics"];
  if (s.includes("sci")) return ["Science", "General Science", "Physical Science"];
  if (s.includes("read") || s.includes("english") || s.includes("ela") || s.includes("lang")) {
    return [
      "English Language Arts",
      "Reading",
      "English",
      "ELA",
      "Language Arts",
    ];
  }
  return [subj];
}

interface TopicQuestion {
  questionText: string;
  options: { id: string; text: string; isCorrect: boolean }[];
  correctAnswer: string;
  explanation: string;
  difficulty: string;
  confidence: number;
}

function getGradePedagogy(gradeLevel: string) {
  const g = (gradeLevel || "").toLowerCase();
  if (g.includes("5") || g.includes("fifth")) {
    return {
      tierName: "5th Grade (Upper Elementary)",
      ageTarget: "10–11 years old",
      cognitiveFocus: "Conceptual depth, multi-step problem solving, error analysis, and mathematical/scientific reasoning.",
      lexileGuidelines: "Use accurate 5th-grade academic vocabulary (e.g. numerator, denominator, equivalent, product, quotient, area, volume, coordinate, axis, producer, decomposer, primary source) framed in clear, encouraging sentences.",
      studyMission: "Every question must help a 5th grader actively STUDY and grasp WHY rules work, not just memorize calculations.",
      realWorldThemes: "Cooking recipes, building projects, allowance/shopping, travel times, sports statistics, nature observation, science experiments.",
    };
  } else if (g.includes("k") || g.includes("1") || g.includes("2")) {
    return {
      tierName: "Early Primary (K–2nd Grade)",
      ageTarget: "5–7 years old",
      cognitiveFocus: "Sensory learning, visual identification, 1-step counting, and foundational recognition.",
      lexileGuidelines: "Short, friendly sentences (< 15 words) with basic phonetics.",
      studyMission: "Build confidence and connect symbols to concrete physical objects.",
      realWorldThemes: "Toys, fruits, animals, playground games, colors, shapes.",
    };
  } else if (g.includes("3") || g.includes("4")) {
    return {
      tierName: "Middle Primary (3rd–4th Grade)",
      ageTarget: "8–9 years old",
      cognitiveFocus: "Bridging concrete to abstract, 2-step word problems, using visual models (number lines, arrays, area models).",
      lexileGuidelines: "Clear context clues, familiar everyday situations.",
      studyMission: "Strengthen multi-step operations and understanding of relationships between concepts.",
      realWorldThemes: "School projects, sports games, pet care, family trips, saving coins.",
    };
  }
  return {
    tierName: "Secondary / General",
    ageTarget: "12+ years old",
    cognitiveFocus: "Abstract synthesis, algebraic modeling, multi-variable thinking, and critical analysis.",
    lexileGuidelines: "Scholastic rigor and precise technical terminology.",
    studyMission: "Evaluate evidence, identify logical fallacies, and master multi-stage procedures.",
    realWorldThemes: "Science labs, technology, economics, history, engineering scenarios.",
  };
}

async function generateQuestionsForTopic({
  topic,
  subject,
  gradeLevel,
  count,
  geminiKey,
  activeGroqKey,
  groqClient,
  existingQuestions = [],
  engine = "groq",
  onCooldown,
}: {
  topic: string;
  subject: string;
  gradeLevel: string;
  count: number;
  geminiKey?: string;
  activeGroqKey?: string;
  groqClient: Groq;
  existingQuestions?: string[];
  engine?: "groq" | "curriculum";
  onCooldown?: (seconds: number, attempt: number, message: string) => void;
}): Promise<TopicQuestion[]> {
  function sanitizeKidExplanation(raw: string): string {
    if (!raw) return "";
    return raw
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^(thinking process|reasoning|internal analysis|rationale):\s*/gi, "")
      .replace(/(?:distractor|misconception)\s+[A-D]\b[^.\n]*[.\n]?/gi, "")
      .trim();
  }

  // OPTION A: Explicitly Selected Built-In Curriculum Engine
  if (engine === "curriculum") {
    console.log(`Using built-in curriculum engine for topic "${topic}" (explicitly selected).`);
    const curriculumQuestions = generateCurriculumQuestions(topic, subject, gradeLevel, count, existingQuestions);
    return curriculumQuestions.map((q) => {
      const shuffled = shuffleMcqOptions(q.options, q.correctAnswer);
      return {
        ...q,
        options: shuffled.options,
        correctAnswer: shuffled.correctAnswer,
        explanation: sanitizeKidExplanation(q.explanation),
      };
    });
  }

  // OPTION B: Groq AI Generation with Cooldown Management
  const pedagogy = getGradePedagogy(gradeLevel);
  const lowerSubject = subject.toLowerCase();
  let subjectFocus = "";

  if (lowerSubject.includes("math") || lowerSubject.includes("arithmetic") || lowerSubject.includes("algebra")) {
    subjectFocus = `MATHEMATICS STUDY FOCUS:
- Emphasize WHY mathematical algorithms work, not just routine arithmetic.
- Include conceptual meaning of symbols and numbers.
- Provide real-life word problems with units (cm, meters, cups, dollars).
- Include "Spot the Mistake" error-analysis where common student calculation traps occur.`;
  } else if (lowerSubject.includes("social") || lowerSubject.includes("history") || lowerSubject.includes("geography") || lowerSubject.includes("civic")) {
    subjectFocus = `SOCIAL SCIENCE & CIVICS STUDY FOCUS:
- Focus on cause-and-effect relationships: WHY did historical events happen and what were the consequences?
- Emphasize reading maps, understanding rights/responsibilities, and evaluating primary vs secondary sources.
- Avoid trivial date memorization; prioritize understanding societal concepts and governance.`;
  } else if (lowerSubject.includes("science") || lowerSubject.includes("biology") || lowerSubject.includes("physics")) {
    subjectFocus = `SCIENCE STUDY FOCUS:
- Focus on the scientific method, ecosystems, matter, energy, and Earth systems.
- Emphasize cause-and-effect, controlled variables ("fair tests"), and interpreting observations.
- Connect concepts directly to everyday natural phenomena.`;
  } else {
    subjectFocus = `READING & LANGUAGE ARTS STUDY FOCUS:
- Focus on reading comprehension, main ideas, author's purpose, text structure, and figurative language.
- Provide clear context paragraphs or sentences for the student to analyze.`;
  }

  const antiDuplicationDirective =
    existingQuestions.length > 0
      ? `\nCRITICAL ANTI-DUPLICATION RULE (ZERO REPETITION):
The following questions ALREADY EXIST in our database for this topic. You MUST NOT duplicate, rephrase, copy, or make minor number/word swaps of any of these:
${existingQuestions.slice(0, 10).map((q, idx) => `  ${idx + 1}. "${q.slice(0, 110)}"`).join("\n")}

Every single question you generate MUST introduce a completely NEW angle, fresh real-world scenario, distinct numbers, or alternative problem format!\n`
      : "";

  const prompt = `You are a master K-12 pedagogical assessment architect and study-coach designer.
Design exactly ${count} high-impact, study-oriented multiple-choice questions for:
- Grade Level: ${gradeLevel} (${pedagogy.tierName}, Learner Age: ${pedagogy.ageTarget})
- Subject: ${subject}
- Topic: ${topic}

PEDAGOGICAL & GRADE CALIBRATION (CRITICAL REQUIREMENT):
- Cognitive Demand: ${pedagogy.cognitiveFocus}
- Reading Level: ${pedagogy.lexileGuidelines}
- Study Mission: ${pedagogy.studyMission}
- Relatable Contexts: ${pedagogy.realWorldThemes}

${subjectFocus}
${antiDuplicationDirective}
MANDATORY STUDY-COACH ARCHETYPES (CRITICAL ANTI-MONOTONY RULE):
To ensure questions act as an interactive STUDY GUIDE rather than repetitive pop-quiz drills, you MUST distribute the ${count} questions across these distinct learning archetypes:

1. ARCHETYPE 1 — CONCEPT & RULE DIAGNOSTIC:
   Tests the underlying definition, "why it works", or foundational principle before calculating (e.g. "What does the denominator represent in a fraction?", "Why must we find a common denominator before adding?").

2. ARCHETYPE 2 — VISUAL, SPATIAL, OR MODEL REASONING:
   Asks the student to interpret or identify a mental or visual model (e.g. number line intervals, area grids, coordinate positions, diagram, or chart representation).

3. ARCHETYPE 3 — EVERYDAY REAL-WORLD WORD PROBLEM:
   A rich multi-step scenario with relatable student names (Aarav, Priya, Maya, Lucas, Elena), realistic quantities, and a clear story context (e.g. baking, building, sports stats).

4. ARCHETYPE 4 — "SPOT THE MISTAKE" (ERROR ANALYSIS & TRAP DIAGNOSIS):
   Presents a fictional student's flawed attempt (e.g. "Aarav tried to solve X and got Y. Which step contains his error?") and asks the student to diagnose the mistake.

5. ARCHETYPE 5 — REVERSE & MULTI-STEP SYNTHESIS CHALLENGE:
   A non-routine challenge requiring two-step reasoning or working backwards from a known outcome to find an unknown value.

CRITICAL ANTI-REPETITION CONSTRAINTS:
- NEVER generate two bare calculation drills (e.g. "What is 12 × 4?" and "What is 15 × 3?"). That is strictly forbidden!
- NEVER repeat question stems (e.g. avoid starting multiple questions with "What is...").
- Distribute questions across the 5 archetypes so each question teaches a distinct dimension of "${topic}".

Difficulty Distribution:
- ~30% Easy (foundational recall and direct concept recognition)
- ~40% Medium (application, two-step reasoning)
- ~30% Hard (multi-step synthesis, non-routine critical thinking)

For each question, provide:
1. Clear, engaging, and grade-appropriate question text specifically about "${topic}" in ${subject}
2. CRITICAL MCQ OPTION CONSTRAINT: EXACTLY 4 options (A, B, C, D) with exactly one definitively correct answer and 3 realistic distractors reflecting common student misconceptions. UNDER NO CIRCUMSTANCES should you ever return 2 options (True/False or binary) or 3 options!
3. The letter of the correct answer: MUST be generously and evenly distributed across A, B, C, and D across the set (~25% each). DO NOT bias toward B or any single letter!
4. A "STUDY COACH" KID-FRIENDLY EXPLANATION:
   - Written directly to a ${pedagogy.tierName} student in clear, friendly language.
   - Concise 2-3 sentence format: "Step 1: [Core concept]. Step 2: [Why the correct answer works]. 💡 Tip: [Quick memory hint]."
5. Difficulty level ("easy", "medium", or "hard")
6. A confidence score from 92-100

Return ONLY valid JSON in this exact format with no extra text:
{
  "questions": [
    {
      "questionText": "...",
      "options": [
        {"id": "A", "text": "...", "isCorrect": true},
        {"id": "B", "text": "...", "isCorrect": false},
        {"id": "C", "text": "...", "isCorrect": false},
        {"id": "D", "text": "...", "isCorrect": false}
      ],
      "correctAnswer": "A",
      "explanation": "Step 1: ... Step 2: ... 💡 Tip: ...",
      "difficulty": "medium",
      "confidence": 96
    }
  ]
}`;

  let topicQuestions: TopicQuestion[] = [];

  const hasGroq = Boolean(
    (activeGroqKey && activeGroqKey !== "your-groq-api-key-here") || process.env.GROQ_API_KEY
  );

  if (hasGroq) {
    const client =
      activeGroqKey && activeGroqKey !== "your-groq-api-key-here"
        ? new Groq({ apiKey: activeGroqKey })
        : groqClient;

    const maxOutputTokens = Math.min(Math.max(count * 500, 1800), 3800);

    const parseGroqResponse = (content: string | null | undefined): TopicQuestion[] => {
      if (!content) return [];
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
          return parsed.questions
            .filter((q: any) => q && (q.questionText || q.question))
            .map((q: any) => {
              const rawOpts = Array.isArray(q.options) ? q.options : [];
              const shuffled = shuffleMcqOptions(rawOpts, q.correctAnswer);
              return {
                questionText: q.questionText || q.question || "",
                options: shuffled.options,
                correctAnswer: shuffled.correctAnswer,
                explanation: q.explanation || "",
                difficulty: q.difficulty || "medium",
                confidence: q.confidence || 95,
              };
            });
        }
      } catch (e) {}
      return [];
    };

    // Robust Groq Caller with Cooldown Management
    const callGroqWithCooldown = async (
      modelName: string,
      maxRetries = 4
    ): Promise<TopicQuestion[]> => {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const completion = await client.chat.completions.create({
            model: modelName,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.75,
            max_tokens: maxOutputTokens,
            response_format: { type: "json_object" },
          });
          const questions = parseGroqResponse(completion.choices[0]?.message?.content);
          if (questions.length > 0) {
            return questions;
          }
        } catch (err: any) {
          const isRateLimit =
            err?.status === 429 ||
            err?.message?.includes("429") ||
            err?.message?.includes("rate_limit") ||
            err?.message?.includes("tokens") ||
            err?.message?.includes("OTPM");

          if (isRateLimit && attempt < maxRetries) {
            // Groq resets quickly: cooldown 4s, 8s, 12s, 16s
            const cooldownSec = 2 + attempt * 4;
            const msg = `Groq token limit reached. Cooling down for ${cooldownSec}s (attempt ${attempt}/${maxRetries}) before retrying Groq...`;
            console.warn(msg);
            if (onCooldown) {
              onCooldown(cooldownSec, attempt, msg);
            }
            await new Promise((resolve) => setTimeout(resolve, cooldownSec * 1000));
            continue;
          }
          throw err;
        }
      }
      return [];
    };

    // 1. Attempt Primary Groq Model (openai/gpt-oss-120b) with cooldown
    try {
      topicQuestions = await callGroqWithCooldown(PRIMARY_GENERATION_MODEL, 4);
      if (topicQuestions.length > 0) {
        console.log(`Successfully generated ${topicQuestions.length} questions for "${topic}" via ${PRIMARY_GENERATION_MODEL}`);
      }
    } catch (primaryErr: any) {
      console.warn(`Groq primary (${PRIMARY_GENERATION_MODEL}) failed for "${topic}": ${primaryErr?.message || primaryErr}. Trying secondary model (${SECONDARY_GENERATION_MODEL}) with cooldown...`);
      try {
        topicQuestions = await callGroqWithCooldown(SECONDARY_GENERATION_MODEL, 3);
        if (topicQuestions.length > 0) {
          console.log(`Successfully generated ${topicQuestions.length} questions for "${topic}" via secondary ${SECONDARY_GENERATION_MODEL}`);
        }
      } catch (secondaryErr: any) {
        console.error(`Groq secondary (${SECONDARY_GENERATION_MODEL}) also failed for "${topic}":`, secondaryErr?.message || secondaryErr);
      }
    }
  }

  // Deduplicate Groq questions against existing DB questions
  let validBatch: TopicQuestion[] = [];
  if (topicQuestions.length > 0) {
    const { uniqueQuestions } = filterDuplicates(topicQuestions, existingQuestions, 0.70);
    validBatch = uniqueQuestions;
  }

  // If deficit exists in Groq mode, query Groq up to 2 times for remaining questions (never automatic fallback)
  let deficitAttempts = 0;
  while (validBatch.length < count && hasGroq && deficitAttempts < 2) {
    deficitAttempts++;
    const needed = count - validBatch.length;
    const allSeen = [...existingQuestions, ...validBatch.map((q) => q.questionText)];
    try {
      const deficitPrompt = `Generate exactly ${needed} additional unique multiple-choice question(s) for ${topic} in ${subject} (${gradeLevel}).
CRITICAL MCQ OPTION RULE: Each question MUST have EXACTLY 4 OPTIONS: A, B, C, and D (1 correct and 3 distinct wrong options). NEVER RETURN 2 OR 3 OPTIONS!
DO NOT DUPLICATE ANY OF THESE: ${allSeen.slice(0, 10).map((q, idx) => `${idx + 1}. "${q.slice(0, 90)}"`).join("; ")}
Return ONLY valid JSON: {"questions": [{"questionText":"...","options":[{"id":"A","text":"...","isCorrect":true},{"id":"B","text":"...","isCorrect":false},{"id":"C","text":"...","isCorrect":false},{"id":"D","text":"...","isCorrect":false}],"correctAnswer":"A","explanation":"Step 1: ... Step 2: ... 💡 Tip: ...","difficulty":"medium","confidence":95}]}`;
      const client = activeGroqKey && activeGroqKey !== "your-groq-api-key-here" ? new Groq({ apiKey: activeGroqKey }) : groqClient;
      const deficitRes = await client.chat.completions.create({
        model: PRIMARY_GENERATION_MODEL,
        messages: [{ role: "user", content: deficitPrompt }],
        temperature: 0.75,
        max_tokens: Math.min(Math.max(needed * 500, 1200), 2500),
        response_format: { type: "json_object" },
      });
      const parsed = JSON.parse(deficitRes.choices[0]?.message?.content || "{}");
      if (Array.isArray(parsed.questions)) {
        const extra: TopicQuestion[] = parsed.questions
          .filter((q: any) => q && (q.questionText || q.question))
          .map((q: any) => {
            const rawOpts = Array.isArray(q.options) ? q.options : [];
            const shuffled = shuffleMcqOptions(rawOpts, q.correctAnswer);
            return {
              questionText: q.questionText || q.question || "",
              options: shuffled.options,
              correctAnswer: shuffled.correctAnswer,
              explanation: q.explanation || "",
              difficulty: q.difficulty || "medium",
              confidence: q.confidence || 95,
            };
          });
        const { uniqueQuestions: uniqueExtras } = filterDuplicates(extra, allSeen, 0.70);
        validBatch = [...validBatch, ...uniqueExtras];
      }
    } catch (deficitErr) {
      console.warn("Groq deficit backfill error:", deficitErr);
      break;
    }
  }

  // Uniformly shuffle MCQ options across A, B, C, D and ensure explanations are sanitized
  return validBatch.map((q) => {
    const shuffled = q.options?.length === 4 ? q : shuffleMcqOptions(q.options, q.correctAnswer);
    return {
      ...q,
      options: shuffled.options,
      correctAnswer: shuffled.correctAnswer,
      explanation: sanitizeKidExplanation(q.explanation),
    };
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      title,
      gradeLevel,
      subject,
      topics,
      count = 10,
      apiKey,
      stream = true,
      engine = "groq",
    } = body;

    if (!title || !gradeLevel || !subject || !topics?.length) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // 1. Create SyllabusPack in Database
    let pack: { id: bigint | number };
    try {
      pack = await prisma.syllabusPack.create({
        data: { title, gradeLevel, subject, topics },
      });
    } catch (dbError) {
      console.warn("Syllabus pack DB creation error (fallback mock id used):", dbError);
      pack = { id: BigInt(Date.now()) };
    }

    const headerApiKey =
      req.headers.get("x-api-key") ||
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
      undefined;
    const effectiveKey = apiKey || headerApiKey;

    const geminiKey =
      effectiveKey?.startsWith("AIza") ? effectiveKey : process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    const activeGroqKey =
      effectiveKey && !effectiveKey.startsWith("AIza") && !effectiveKey.startsWith("sk-")
        ? effectiveKey
        : process.env.GROQ_API_KEY;

    const groqClient =
      activeGroqKey && activeGroqKey !== "your-groq-api-key-here"
        ? new Groq({ apiKey: activeGroqKey })
        : groq;

    const totalTopics = (topics as string[]).length;
    let totalExpected = totalTopics * count;

    // STREAMING MODE: Send live progress events per topic
    if (stream) {
      const encoder = new TextEncoder();
      const readableStream = new ReadableStream({
        async start(controller) {
          try {
            // Send initial metadata
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  type: "init",
                  packId: Number(pack.id),
                  totalTopics,
                  topics,
                  countPerTopic: count,
                  totalExpected,
                }) + "\n"
              )
            );

            let totalGenerated = 0;
            const sessionPackQuestions: string[] = [];

            for (let i = 0; i < totalTopics; i++) {
              if (req.signal?.aborted) {
                console.log("Client aborted question generation stream.");
                break;
              }

              const topic = topics[i];

              // Notify client which topic is now being generated
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    type: "topic_start",
                    topic,
                    topicIndex: i + 1,
                    totalTopics,
                    totalGenerated,
                    totalExpected,
                    percent: Math.min(100, Math.round((totalGenerated / totalExpected) * 100)),
                  }) + "\n"
                )
              );

              const gradeVariants = getGradeVariants(gradeLevel);
              const subjectVariants = getSubjectVariants(subject);

              // Fetch existing questions for this topic to guarantee 0 repetition
              const existingRecords = await prisma.question.findMany({
                where: {
                  gradeLevel: { in: gradeVariants },
                  subject: { in: subjectVariants },
                  topic: { equals: topic, mode: "insensitive" },
                },
                select: { questionText: true },
                take: 300,
              });
              const existingQuestions = existingRecords.map((r) => r.questionText);
              // Combine DB existing questions with all questions saved in this generation session
              const savedInSessionTexts = [...existingQuestions, ...sessionPackQuestions];

              // Formulate questions for this topic with anti-duplication memory
              const topicQuestions = await generateQuestionsForTopic({
                topic,
                subject,
                gradeLevel,
                count,
                geminiKey,
                activeGroqKey,
                groqClient,
                existingQuestions: savedInSessionTexts,
                engine: engine as "groq" | "curriculum",
                onCooldown: (seconds, attempt, message) => {
                  controller.enqueue(
                    encoder.encode(
                      JSON.stringify({
                        type: "cooldown",
                        topic,
                        topicIndex: i + 1,
                        totalTopics,
                        seconds,
                        attempt,
                        message,
                        percent: Math.min(100, Math.round((totalGenerated / totalExpected) * 100)),
                      }) + "\n"
                    )
                  );
                },
              });

              let topicInserted = 0;

              // Save to database with pre-insert duplicate check
              for (const q of topicQuestions) {
                if (topicInserted >= count) break;
                try {
                  // Check semantic & structural duplicates against existing + session questions
                  if (isDuplicate(q.questionText, savedInSessionTexts, 0.65)) {
                    console.log(`Skipped duplicate question in batch: "${q.questionText.slice(0, 45)}..."`);
                    continue;
                  }

                  const alreadyExists = await prisma.question.findFirst({
                    where: {
                      gradeLevel: { in: gradeVariants },
                      subject: { in: subjectVariants },
                      topic: { equals: topic, mode: "insensitive" },
                      questionText: { equals: q.questionText, mode: "insensitive" },
                    },
                    select: { id: true },
                  });

                  if (alreadyExists) {
                    console.log(`Skipped existing duplicate question in DB: "${q.questionText.slice(0, 45)}..."`);
                    continue;
                  }

                  const safeOptions =
                    Array.isArray(q.options) && q.options.length === 4
                      ? q.options
                      : shuffleMcqOptions(q.options || [], q.correctAnswer).options;

                  await prisma.question.create({
                    data: {
                      syllabusPackId: pack.id,
                      questionText: q.questionText,
                      options: safeOptions as any,
                      correctAnswer: q.correctAnswer,
                      explanation: q.explanation,
                      gradeLevel,
                      subject,
                      topic,
                      difficulty: q.difficulty || "medium",
                      confidence: q.confidence || 95,
                      status: "draft",
                    },
                  });
                  savedInSessionTexts.push(q.questionText);
                  sessionPackQuestions.push(q.questionText);
                  topicInserted++;
                  totalGenerated++;
                } catch (saveError) {
                  console.warn("DB question save error:", saveError);
                }
              }

              // Backfill in Groq mode if duplicates were skipped and target count not reached
              if (engine === "groq" && topicInserted < count) {
                const needed = count - topicInserted;
                console.log(`Topic "${topic}" Groq backfilling ${needed} question(s) to reach target count of ${count}...`);
                try {
                  const retryQuestions = await generateQuestionsForTopic({
                    topic,
                    subject,
                    gradeLevel,
                    count: needed,
                    geminiKey,
                    activeGroqKey,
                    groqClient,
                    existingQuestions: savedInSessionTexts,
                    engine: "groq",
                  });

                  for (const q of retryQuestions) {
                    if (topicInserted >= count) break;
                    if (isDuplicate(q.questionText, savedInSessionTexts, 0.65)) continue;

                    const safeOpts =
                      Array.isArray(q.options) && q.options.length === 4
                        ? q.options
                        : shuffleMcqOptions(q.options || [], q.correctAnswer).options;

                    await prisma.question.create({
                      data: {
                        syllabusPackId: pack.id,
                        questionText: q.questionText,
                        options: safeOpts as any,
                        correctAnswer: q.correctAnswer,
                        explanation: q.explanation,
                        gradeLevel,
                        subject,
                        topic,
                        difficulty: q.difficulty || "medium",
                        confidence: q.confidence || 95,
                        status: "draft",
                      },
                    });
                    savedInSessionTexts.push(q.questionText);
                    sessionPackQuestions.push(q.questionText);
                    topicInserted++;
                    totalGenerated++;
                  }
                } catch (retryErr) {
                  console.warn("Groq topic backfill error:", retryErr);
                }
              }

              // Backfill ONLY if engine === "curriculum" (never automatic when Groq is chosen)
              if (engine === "curriculum" && topicInserted < count) {
                const needed = count - topicInserted;
                console.log(`Topic "${topic}" backfilling ${needed} question(s) via curriculum engine`);
                const backfillList = generateCurriculumQuestions(
                  topic,
                  subject,
                  gradeLevel,
                  needed + 3,
                  savedInSessionTexts
                );

                for (const q of backfillList) {
                  if (topicInserted >= count) break;
                  if (isDuplicate(q.questionText, savedInSessionTexts, 0.65)) continue;

                  const safeOpts =
                    Array.isArray(q.options) && q.options.length === 4
                      ? q.options
                      : shuffleMcqOptions(q.options || [], q.correctAnswer).options;

                  try {
                    await prisma.question.create({
                      data: {
                        syllabusPackId: pack.id,
                        questionText: q.questionText,
                        options: safeOpts as any,
                        correctAnswer: q.correctAnswer,
                        explanation: q.explanation,
                        gradeLevel,
                        subject,
                        topic,
                        difficulty: q.difficulty || "medium",
                        confidence: q.confidence || 95,
                        status: "draft",
                      },
                    });
                    savedInSessionTexts.push(q.questionText);
                    sessionPackQuestions.push(q.questionText);
                    topicInserted++;
                    totalGenerated++;
                  } catch (bfErr) {
                    console.warn("Backfill DB save error:", bfErr);
                  }
                }
              }

              // If still underfilled, adjust totalExpected so percentage stays honest & reaches 100%
              if (topicInserted < count) {
                totalExpected = Math.max(totalGenerated, totalExpected - (count - topicInserted));
              }

              // Notify client that this topic is complete
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    type: "topic_done",
                    topic,
                    topicIndex: i + 1,
                    totalTopics,
                    questionsAdded: topicInserted,
                    totalGenerated,
                    totalExpected,
                    percent: Math.min(100, Math.round((totalGenerated / totalExpected) * 100)),
                  }) + "\n"
                )
              );

              // 1000ms buffer between topics to keep token rate limits smooth and prevent OTPM spikes
              if (totalTopics > 1 && i < totalTopics - 1) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
            }

            // Final completion message
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  type: "complete",
                  success: true,
                  packId: Number(pack.id),
                  totalGenerated,
                  count: totalGenerated,
                  percent: 100,
                }) + "\n"
              )
            );
          } catch (streamError) {
            console.error("Stream generation error:", streamError);
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  type: "error",
                  error: streamError instanceof Error ? streamError.message : "Generation failed.",
                }) + "\n"
              )
            );
          } finally {
            controller.close();
          }
        },
      });

      return new Response(readableStream, {
        headers: {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache, no-transform",
        },
      });
    }

    // NON-STREAMING FALLBACK
    let totalGenerated = 0;
    const sessionPackQuestions: string[] = [];

    for (let i = 0; i < totalTopics; i++) {
      const topic = topics[i];
      const gradeVariants = getGradeVariants(gradeLevel);
      const subjectVariants = getSubjectVariants(subject);

      const existingRecords = await prisma.question.findMany({
        where: {
          gradeLevel: { in: gradeVariants },
          subject: { in: subjectVariants },
          topic: { equals: topic, mode: "insensitive" },
        },
        select: { questionText: true },
        take: 300,
      });
      const existingQuestions = existingRecords.map((r) => r.questionText);
      const savedInSessionTexts = [...existingQuestions, ...sessionPackQuestions];

      const topicQuestions = await generateQuestionsForTopic({
        topic,
        subject,
        gradeLevel,
        count,
        geminiKey,
        activeGroqKey,
        groqClient,
        existingQuestions: savedInSessionTexts,
        engine: engine as "groq" | "curriculum",
      });

      let topicInserted = 0;

      for (const q of topicQuestions) {
        if (topicInserted >= count) break;
        try {
          if (isDuplicate(q.questionText, savedInSessionTexts, 0.65)) {
            console.log(`Skipped duplicate question in batch: "${q.questionText.slice(0, 45)}..."`);
            continue;
          }

          const alreadyExists = await prisma.question.findFirst({
            where: {
              gradeLevel: { in: gradeVariants },
              subject: { in: subjectVariants },
              topic: { equals: topic, mode: "insensitive" },
              questionText: { equals: q.questionText, mode: "insensitive" },
            },
            select: { id: true },
          });

          if (alreadyExists) {
            console.log(`Skipped existing duplicate question in DB: "${q.questionText.slice(0, 45)}..."`);
            continue;
          }

          const safeOptions =
            Array.isArray(q.options) && q.options.length === 4
              ? q.options
              : shuffleMcqOptions(q.options || [], q.correctAnswer).options;

          await prisma.question.create({
            data: {
              syllabusPackId: pack.id,
              questionText: q.questionText,
              options: safeOptions as any,
              correctAnswer: q.correctAnswer,
              explanation: q.explanation,
              gradeLevel,
              subject,
              topic,
              difficulty: q.difficulty || "medium",
              confidence: q.confidence || 95,
              status: "draft",
            },
          });
          savedInSessionTexts.push(q.questionText);
          sessionPackQuestions.push(q.questionText);
          topicInserted++;
          totalGenerated++;
        } catch (saveError) {
          console.warn("DB question save error:", saveError);
        }
      }

      // Backfill in Groq mode if duplicates were skipped and target count not reached
      if (engine === "groq" && topicInserted < count) {
        const needed = count - topicInserted;
        console.log(`Topic "${topic}" Groq backfilling ${needed} question(s) to reach target count of ${count}...`);
        try {
          const retryQuestions = await generateQuestionsForTopic({
            topic,
            subject,
            gradeLevel,
            count: needed,
            geminiKey,
            activeGroqKey,
            groqClient,
            existingQuestions: savedInSessionTexts,
            engine: "groq",
          });

          for (const q of retryQuestions) {
            if (topicInserted >= count) break;
            if (isDuplicate(q.questionText, savedInSessionTexts, 0.65)) continue;

            const safeOpts =
              Array.isArray(q.options) && q.options.length === 4
                ? q.options
                : shuffleMcqOptions(q.options || [], q.correctAnswer).options;

            await prisma.question.create({
              data: {
                syllabusPackId: pack.id,
                questionText: q.questionText,
                options: safeOpts as any,
                correctAnswer: q.correctAnswer,
                explanation: q.explanation,
                gradeLevel,
                subject,
                topic,
                difficulty: q.difficulty || "medium",
                confidence: q.confidence || 95,
                status: "draft",
              },
            });
            savedInSessionTexts.push(q.questionText);
            sessionPackQuestions.push(q.questionText);
            topicInserted++;
            totalGenerated++;
          }
        } catch (retryErr) {
          console.warn("Groq topic backfill error:", retryErr);
        }
      }

      // Backfill ONLY if engine === "curriculum" (never automatic when Groq is chosen)
      if (engine === "curriculum" && topicInserted < count) {
        const needed = count - topicInserted;
        const backfillList = generateCurriculumQuestions(
          topic,
          subject,
          gradeLevel,
          needed + 3,
          savedInSessionTexts
        );

        for (const q of backfillList) {
          if (topicInserted >= count) break;
          if (isDuplicate(q.questionText, savedInSessionTexts, 0.65)) continue;

          const safeOpts =
            Array.isArray(q.options) && q.options.length === 4
              ? q.options
              : shuffleMcqOptions(q.options || [], q.correctAnswer).options;

          try {
            await prisma.question.create({
              data: {
                syllabusPackId: pack.id,
                questionText: q.questionText,
                options: safeOpts as any,
                correctAnswer: q.correctAnswer,
                explanation: q.explanation,
                gradeLevel,
                subject,
                topic,
                difficulty: q.difficulty || "medium",
                confidence: q.confidence || 95,
                status: "draft",
              },
            });
            savedInSessionTexts.push(q.questionText);
            sessionPackQuestions.push(q.questionText);
            topicInserted++;
            totalGenerated++;
          } catch (bfErr) {
            console.warn("Backfill DB save error:", bfErr);
          }
        }
      }

      if (totalTopics > 1 && i < totalTopics - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    return NextResponse.json({
      success: true,
      packId: Number(pack.id),
      questionsGenerated: totalGenerated,
      count: totalGenerated,
    });
  } catch (error) {
    console.error("Critical generation error:", error);
    return NextResponse.json(
      { error: "Generation failed. Please try again." },
      { status: 500 }
    );
  }
}
