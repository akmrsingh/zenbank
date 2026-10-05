import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders });
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const search = searchParams.get("search");
    const batchId = searchParams.get("batchId");
    const topic = searchParams.get("topic");
    const gradeLevel = searchParams.get("gradeLevel");
    const subject = searchParams.get("subject");
    const limit = parseInt(searchParams.get("limit") || "100", 10);
    // My Zen Learning daily sync: skip heavy stats counts + pack joins
    const slim =
      searchParams.get("slim") === "1" || searchParams.get("for") === "sync";

    const where: Record<string, unknown> = {};
    if (status && status !== "all") where.status = status;
    if (batchId && batchId !== "all") where.syllabusPackId = BigInt(batchId);
    if (topic && topic !== "all") where.topic = { equals: topic, mode: "insensitive" };
    if (gradeLevel && gradeLevel !== "all") where.gradeLevel = { contains: gradeLevel, mode: "insensitive" };
    if (subject && subject !== "all") where.subject = { contains: subject, mode: "insensitive" };
    if (search) {
      where.questionText = { contains: search, mode: "insensitive" };
    }

    if (slim) {
      const questions = await prisma.question.findMany({
        where,
        select: {
          id: true,
          syllabusPackId: true,
          questionText: true,
          options: true,
          correctAnswer: true,
          explanation: true,
          gradeLevel: true,
          subject: true,
          topic: true,
          difficulty: true,
          confidence: true,
          status: true,
        },
        orderBy: { id: "asc" },
        take: limit,
      });

      return NextResponse.json(
        {
          questions: questions.map((q) => ({
            ...q,
            id: Number(q.id),
            syllabusPackId: q.syllabusPackId ? Number(q.syllabusPackId) : null,
          })),
          stats: null,
        },
        { headers: corsHeaders }
      );
    }

    const [questions, total, drafts, verified, flagged] = await Promise.all([
      prisma.question.findMany({
        where,
        include: {
          syllabusPack: {
            select: {
              id: true,
              title: true,
              gradeLevel: true,
              subject: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.question.count(),
      prisma.question.count({ where: { status: "draft" } }),
      prisma.question.count({ where: { status: "verified" } }),
      prisma.question.count({ where: { status: "flagged" } }),
    ]);

    return NextResponse.json(
      {
        questions: questions.map((q) => ({
          ...q,
          id: Number(q.id),
          syllabusPackId: q.syllabusPackId ? Number(q.syllabusPackId) : null,
          syllabusPack: q.syllabusPack
            ? {
                id: Number(q.syllabusPack.id),
                title: q.syllabusPack.title,
                gradeLevel: q.syllabusPack.gradeLevel,
                subject: q.syllabusPack.subject,
                createdAt: q.syllabusPack.createdAt.toISOString(),
              }
            : null,
        })),
        stats: { total, drafts, verified, flagged },
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error("Questions fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch questions" },
      { status: 500, headers: corsHeaders }
    );
  }
}
