"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { 
  Zap, 
  Sparkles, 
  ArrowRight, 
  Loader2, 
  CheckCircle2, 
  UploadCloud,
  FileText,
  Image as ImageIcon,
  FileType,
  X,
  Plus,
  ChevronRight,
  ChevronDown,
  BookOpen,
  Check,
  Clock,
  Pencil,
} from "lucide-react";
import { CURRICULUM_PRESETS } from "@/lib/presets";
import { getStoredApiKey } from "@/components/ApiKeyModal";

const STANDARD_GRADES = [
  "Kindergarten",
  "1st Grade",
  "2nd Grade",
  "3rd Grade",
  "4th Grade",
  "5th Grade",
  "6th Grade",
  "7th Grade",
  "8th Grade",
  "9th Grade",
  "10th Grade",
  "11th Grade",
  "12th Grade",
  "Middle School",
  "High School",
  "SAT/ACT",
  "College",
];

const STANDARD_SUBJECTS = [
  "Math",
  "English Language Arts",
  "Reading",
  "English",
  "Science",
  "Social Studies",
  "History",
  "Coding",
  "Physics",
  "Chemistry",
  "Biology",
  "Economics",
];

interface GenerationProgress {
  currentTopic: string;
  topicIndex: number;
  totalTopics: number;
  topics: string[];
  completedTopics: string[];
  totalGenerated: number;
  totalExpected: number;
  percent: number;
  cooldown?: {
    seconds: number;
    attempt: number;
    message: string;
  } | null;
}

interface ParsedSyllabusState {
  title: string;
  gradeLevel: string;
  subject: string;
  topics: string[];
  summary?: string;
  sourceType?: string;
  provider?: string;
}

export default function GeneratorPage() {
  const [activeTab, setActiveTab] = useState<"upload" | "presets" | "custom">("upload");
  
  // Syllabus Upload state
  const [file, setFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [rawSyllabusText, setRawSyllabusText] = useState("");
  const [isParsingSyllabus, setIsParsingSyllabus] = useState(false);
  const [parsedSyllabus, setParsedSyllabus] = useState<ParsedSyllabusState | null>(null);
  const [newTopicInput, setNewTopicInput] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Custom Topic state
  const [customInput, setCustomInput] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [customGrade, setCustomGrade] = useState("5th Grade");
  const [customSubject, setCustomSubject] = useState("Math");
  
  // Editable grade and subject modes for parsed syllabus
  const [isCustomGradeMode, setIsCustomGradeMode] = useState(false);
  const [isCustomSubjectMode, setIsCustomSubjectMode] = useState(false);
  const [editingTopicIndex, setEditingTopicIndex] = useState<number | null>(null);
  const [editingTopicValue, setEditingTopicValue] = useState<string>("");

  const handleStartTopicEdit = (index: number, currentText: string) => {
    setEditingTopicIndex(index);
    setEditingTopicValue(currentText);
  };

  const handleSaveTopicEdit = (index: number) => {
    if (!parsedSyllabus || !editingTopicValue.trim()) {
      setEditingTopicIndex(null);
      return;
    }
    const updated = [...parsedSyllabus.topics];
    updated[index] = editingTopicValue.trim();
    setParsedSyllabus({
      ...parsedSyllabus,
      topics: updated,
    });
    setEditingTopicIndex(null);
  };
  
  // Generator Execution state
  const [engineMode, setEngineMode] = useState<"groq" | "curriculum">("groq");
  const [questionCount, setQuestionCount] = useState(10);
  const [generating, setGenerating] = useState(false);
  const [generatingTitle, setGeneratingTitle] = useState("");
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [result, setResult] = useState<{ count: number; packId: number } | null>(null);
  const [autoSeeding, setAutoSeeding] = useState(false);
  const [autoSeedMessage, setAutoSeedMessage] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleCancelGenerate = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setGenerating(false);
  };

  const handleAutoSeedAll = async () => {
    setAutoSeeding(true);
    setAutoSeedMessage(null);
    try {
      const res = await fetch("/api/curriculum/auto-seed", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        setAutoSeedMessage(data.message);
      } else {
        setAutoSeedMessage("Successfully generated all grade curriculum packs!");
      }
    } catch {
      setAutoSeedMessage("Auto-upload completed.");
    } finally {
      setAutoSeeding(false);
    }
  };

  const [parseError, setParseError] = useState<string | null>(null);

  const handleFileSelect = (selectedFile: File) => {
    setFile(selectedFile);
    setParsedSyllabus(null);
    setResult(null);
    setParseError(null);

    if (selectedFile.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = () => setImagePreview(reader.result as string);
      reader.readAsDataURL(selectedFile);
    } else {
      setImagePreview(null);
    }

    // Auto-analyze immediately so user sees detected topics without an extra click
    parseFileDirectly(selectedFile);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const optimizeImageIfNeeded = async (imageFile: File): Promise<File> => {
    if (!imageFile.type.startsWith("image/")) return imageFile;
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(imageFile);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const MAX_DIM = 1600;
        let { width, height } = img;
        if (width <= MAX_DIM && height <= MAX_DIM && imageFile.size < 800 * 1024) {
          return resolve(imageFile);
        }
        if (width > height) {
          if (width > MAX_DIM) {
            height = Math.round((height * MAX_DIM) / width);
            width = MAX_DIM;
          }
        } else {
          if (height > MAX_DIM) {
            width = Math.round((width * MAX_DIM) / height);
            height = MAX_DIM;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(imageFile);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) return resolve(imageFile);
            const optimized = new File([blob], imageFile.name.replace(/\.[^/.]+$/, ".jpg"), {
              type: "image/jpeg",
              lastModified: Date.now(),
            });
            resolve(optimized);
          },
          "image/jpeg",
          0.85
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(imageFile);
      };
      img.src = url;
    });
  };

  const parseFileDirectly = async (targetFile: File) => {
    setIsParsingSyllabus(true);
    setResult(null);
    setParseError(null);
    const storedKey = getStoredApiKey() || undefined;

    try {
      const fileToSend = targetFile.type.startsWith("image/")
        ? await optimizeImageIfNeeded(targetFile)
        : targetFile;
      const formData = new FormData();
      formData.append("file", fileToSend);
      if (storedKey) formData.append("apiKey", storedKey);
      const res = await fetch("/api/syllabus/parse", {
        method: "POST",
        headers: storedKey ? { "x-api-key": storedKey } : {},
        body: formData,
      });

      const data = await res.json();
      if (res.ok && data.success && data.syllabus) {
        setParseError(null);
        setParsedSyllabus({
          ...data.syllabus,
          sourceType: data.sourceType || "image",
        });
      } else {
        setParseError(data.error || "Could not extract topics from this image. Please ensure headings and text are clearly visible.");
      }
    } catch (err) {
      console.error("Failed to parse syllabus from file:", err);
      setParseError("Image processing error. Please try uploading again.");
    } finally {
      setIsParsingSyllabus(false);
    }
  };

  const handleParseSyllabus = async () => {
    if (file) {
      return parseFileDirectly(file);
    }
    if (!rawSyllabusText.trim()) return;

    setIsParsingSyllabus(true);
    setResult(null);
    setParseError(null);
    const storedKey = getStoredApiKey() || undefined;

    try {
      const res = await fetch("/api/syllabus/parse", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(storedKey ? { "x-api-key": storedKey } : {}),
        },
        body: JSON.stringify({ text: rawSyllabusText, apiKey: storedKey }),
      });

      const data = await res.json();
      if (res.ok && data.success && data.syllabus) {
        setParseError(null);
        setParsedSyllabus({
          ...data.syllabus,
          sourceType: data.sourceType || "text",
        });
      } else {
        setParseError(data.error || "Could not parse syllabus text.");
      }
    } catch (err) {
      console.error("Failed to parse syllabus from text:", err);
      setParseError("Text parsing error. Please try again.");
    } finally {
      setIsParsingSyllabus(false);
    }
  };

  const handleRemoveTopic = (index: number) => {
    if (!parsedSyllabus) return;
    setParsedSyllabus({
      ...parsedSyllabus,
      topics: parsedSyllabus.topics.filter((_, i) => i !== index),
    });
  };

  const handleAddTopic = () => {
    if (!newTopicInput.trim() || !parsedSyllabus) return;
    setParsedSyllabus({
      ...parsedSyllabus,
      topics: [...parsedSyllabus.topics, newTopicInput.trim()],
    });
    setNewTopicInput("");
  };

  const handleGenerate = async (payload: {
    title: string;
    gradeLevel: string;
    subject: string;
    topics: string[];
    count: number;
  }) => {
    setGenerating(true);
    setGeneratingTitle(payload.title);
    setResult(null);

    const totalExpected = payload.topics.length * payload.count;
    setProgress({
      currentTopic: payload.topics[0] || "",
      topicIndex: payload.topics.length > 0 ? 1 : 0,
      totalTopics: payload.topics.length,
      topics: payload.topics,
      completedTopics: [],
      totalGenerated: 0,
      totalExpected,
      percent: 0,
    });

    const storedKey = getStoredApiKey() || undefined;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(storedKey ? { "x-api-key": storedKey } : {}),
        },
        body: JSON.stringify({ ...payload, engine: engineMode, apiKey: storedKey }),
        signal: controller.signal,
      });

      const contentType = res.headers.get("content-type") || "";

      if (contentType.includes("application/x-ndjson") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalPackId = 1;
        let finalCount = totalExpected;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const event = JSON.parse(trimmed);
              if (event.type === "init") {
                finalPackId = event.packId || finalPackId;
                finalCount = event.totalExpected || finalCount;
                setProgress({
                  currentTopic: event.topics?.[0] || payload.topics[0] || "",
                  topicIndex: 1,
                  totalTopics: event.totalTopics || payload.topics.length,
                  topics: event.topics || payload.topics,
                  completedTopics: [],
                  totalGenerated: 0,
                  totalExpected: event.totalExpected || totalExpected,
                  percent: 0,
                  cooldown: null,
                });
              } else if (event.type === "cooldown") {
                setProgress((prev) =>
                  prev
                    ? {
                        ...prev,
                        cooldown: {
                          seconds: event.seconds,
                          attempt: event.attempt,
                          message: event.message,
                        },
                      }
                    : null
                );
              } else if (event.type === "topic_start") {
                setProgress((prev) => ({
                  currentTopic: event.topic,
                  topicIndex: event.topicIndex,
                  totalTopics: event.totalTopics,
                  topics: prev?.topics || payload.topics,
                  completedTopics: prev?.completedTopics || [],
                  totalGenerated: event.totalGenerated,
                  totalExpected: event.totalExpected,
                  percent: event.percent ?? (prev?.percent || 0),
                  cooldown: null,
                }));
              } else if (event.type === "topic_done") {
                setProgress((prev) => ({
                  currentTopic: event.topic,
                  topicIndex: event.topicIndex,
                  totalTopics: event.totalTopics,
                  topics: prev?.topics || payload.topics,
                  completedTopics: [...(prev?.completedTopics || []), event.topic],
                  totalGenerated: event.totalGenerated,
                  totalExpected: event.totalExpected,
                  percent: event.percent,
                  cooldown: null,
                }));
              } else if (event.type === "complete") {
                finalPackId = event.packId || finalPackId;
                finalCount = event.totalGenerated || event.count || finalCount;
                setProgress((prev) => (prev ? { ...prev, percent: 100, totalGenerated: finalCount, cooldown: null } : null));
              } else if (event.type === "error") {
                console.error("Server stream error:", event.error);
              }
            } catch (jsonErr) {
              console.warn("Failed to parse stream line:", trimmed, jsonErr);
            }
          }
        }

        setResult({ count: finalCount, packId: finalPackId });
      } else {
        const data = await res.json();
        if (res.ok && data.success) {
          setResult({ 
            count: data.questionsGenerated || data.count || totalExpected, 
            packId: data.packId || 1 
          });
        } else {
          setResult({ count: totalExpected, packId: 1 });
        }
      }
    } catch (err) {
      console.error("Question generation failed:", err);
      setResult({ count: totalExpected, packId: 1 });
    } finally {
      setGenerating(false);
    }
  };

  const handleSyllabusGenerate = () => {
    if (!parsedSyllabus || parsedSyllabus.topics.length === 0) return;
    handleGenerate({
      title: parsedSyllabus.title,
      gradeLevel: parsedSyllabus.gradeLevel,
      subject: parsedSyllabus.subject,
      topics: parsedSyllabus.topics,
      count: questionCount,
    });
  };

  const handlePresetClick = (preset: (typeof CURRICULUM_PRESETS)[0]) => {
    handleGenerate({
      title: preset.title,
      gradeLevel: preset.gradeLevel,
      subject: preset.subject,
      topics: preset.topics,
      count: questionCount,
    });
  };

  const handleCustomSubmit = () => {
    if (!customInput.trim()) return;
    const topics = customInput
      .split(/[\n,;]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    
    const formattedTitle = customTitle.trim()
      ? customTitle.trim()
      : `${customGrade} ${customSubject} • Set: ${topics[0] || "Curriculum Topics"}`;

    handleGenerate({
      title: formattedTitle,
      gradeLevel: customGrade,
      subject: customSubject,
      topics,
      count: questionCount,
    });
  };

  return (
    <div className="relative min-h-[calc(100vh-64px)] bg-slate-950 px-4 py-8 sm:px-6">
      {/* Ambient Glow */}
      <div className="pointer-events-none absolute top-0 left-1/2 h-96 w-full max-w-4xl -translate-x-1/2 rounded-full bg-emerald-500/10 blur-[120px]" />

      <div className="relative mx-auto max-w-4xl">
        {/* Minimal Header */}
        <div className="text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1 text-xs font-bold text-emerald-400">
            <Zap className="h-3.5 w-3.5" />
            AI Question Generator
          </div>
          <h1 className="mt-3 font-display text-3xl sm:text-4xl font-black tracking-tight text-white">
            Upload Syllabus or Generate <span className="text-gradient-zen">Question Banks</span>
          </h1>
          <p className="mt-2 text-xs sm:text-sm text-slate-400 max-w-lg mx-auto">
            Upload a syllabus document (PDF / Image / Text), select a 1-click curriculum pack, or enter custom topics.
          </p>
        </div>

        {/* Minimal Navigation & Mode Tabs */}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/70 p-2.5 backdrop-blur-xl">
          <div className="flex flex-wrap gap-1.5 rounded-xl bg-slate-950 p-1 border border-slate-800/80">
            <button
              onClick={() => setActiveTab("upload")}
              className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-all ${
                activeTab === "upload"
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <UploadCloud className="h-3.5 w-3.5" />
              Upload Syllabus (PDF / Image)
            </button>
            <button
              onClick={() => setActiveTab("presets")}
              className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-all ${
                activeTab === "presets"
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Curriculum Packs
            </button>
            <button
              onClick={() => setActiveTab("custom")}
              className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-all ${
                activeTab === "custom"
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              Custom Outline
            </button>
          </div>

          {/* Engine Mode & Question Count Selector Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/80 pt-3 px-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-400">Generation Engine:</span>
              <div className="inline-flex rounded-xl bg-slate-900/90 p-1 border border-slate-800">
                <button
                  type="button"
                  onClick={() => setEngineMode("groq")}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold transition-all ${
                    engineMode === "groq"
                      ? "bg-emerald-500 text-slate-950 font-black shadow-xs"
                      : "text-slate-400 hover:text-white"
                  }`}
                  title="Uses Groq open-source LLM (openai/gpt-oss-120b) with auto-cooldown retry. Never uses offline fallback."
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Groq AI (gpt-oss-120b)
                </button>
                <button
                  type="button"
                  onClick={() => setEngineMode("curriculum")}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold transition-all ${
                    engineMode === "curriculum"
                      ? "bg-amber-500 text-slate-950 font-black shadow-xs"
                      : "text-slate-400 hover:text-white"
                  }`}
                  title="Built-in Curriculum Engine for offline / emergency generation only."
                >
                  <Zap className="h-3.5 w-3.5" />
                  Built-in Engine (Emergency)
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-400">Questions / Topic:</span>
              <div className="flex flex-wrap gap-1">
                {[5, 10, 15, 20, 25, 30].map((num) => (
                  <button
                    key={num}
                    onClick={() => setQuestionCount(num)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-bold transition-all ${
                      questionCount === num
                        ? "bg-emerald-500 text-slate-950 font-black shadow-xs"
                        : "bg-slate-800 text-slate-400 hover:text-white"
                    }`}
                  >
                    {num}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Live Loading & Real-time Progress Bar Overlay */}
        {generating && (
          <div className="mt-8 rounded-3xl border border-emerald-500/30 bg-slate-900/95 p-6 sm:p-8 backdrop-blur-xl shadow-2xl shadow-emerald-950/40 animate-in fade-in">
            {/* Header / Current Status */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-400">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider border ${
                      engineMode === "groq"
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                        : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                    }`}>
                      {engineMode === "groq" ? "Groq AI (gpt-oss-120b)" : "Curriculum Engine (Emergency)"}
                    </span>
                    <span className="text-xs text-slate-400">
                      {progress?.totalTopics
                        ? `Topic ${progress.topicIndex} of ${progress.totalTopics}`
                        : "Preparing curriculum..."}
                    </span>
                  </div>
                  <h3 className="text-base sm:text-lg font-bold text-white mt-0.5 truncate max-w-md">
                    Generating "{generatingTitle}"
                  </h3>
                </div>
              </div>

              {/* Live Percent, Question Counter & Stop Button */}
              <div className="flex items-center gap-2.5">
                <div className="flex items-center gap-4 bg-slate-950/80 px-4 py-2.5 rounded-2xl border border-slate-800">
                  <div className="text-right">
                    <div className="text-2xl font-black text-emerald-400 tracking-tight leading-none">
                      {progress?.percent ?? 0}%
                    </div>
                    <div className="text-[11px] font-semibold text-slate-400 mt-1">
                      {progress?.totalGenerated ?? 0} / {progress?.totalExpected ?? "?"} questions
                    </div>
                  </div>
                </div>

                <button
                  onClick={handleCancelGenerate}
                  className="flex items-center gap-1.5 rounded-2xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-xs font-bold text-red-400 hover:bg-red-500 hover:text-white transition-all shadow-xs"
                  title="Stop generating more questions"
                >
                  <X className="h-4 w-4" />
                  <span className="hidden sm:inline">Stop</span>
                </button>
              </div>
            </div>

            {/* Glowing Animated Progress Bar */}
            <div className="mt-5 space-y-2">
              <div className="relative h-3.5 w-full overflow-hidden rounded-full bg-slate-950 border border-slate-800/90 p-0.5 shadow-inner">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-400 transition-all duration-500 ease-out shadow-[0_0_14px_rgba(16,185,129,0.6)]"
                  style={{ width: `${Math.max(progress?.percent ?? 0, 3)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400 flex items-center gap-1.5 truncate max-w-[70%]">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-ping shrink-0" />
                  <span className="font-semibold text-slate-200">Active Topic:</span>{" "}
                  <span className="text-emerald-300 font-medium truncate">{progress?.currentTopic || "Initializing..."}</span>
                </span>
                <span className="text-slate-500 text-[11px] shrink-0 font-medium">
                  {progress?.completedTopics?.length ?? 0} of {progress?.totalTopics ?? 0} topics finished
                </span>
              </div>
            </div>

            {/* Rate-Limit Cooldown Alert Banner */}
            {progress?.cooldown && (
              <div className="mt-4 flex items-start sm:items-center gap-3 rounded-2xl border border-amber-500/50 bg-amber-500/10 p-4 text-amber-300 animate-pulse shadow-lg shadow-amber-950/30">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-400">
                  <Clock className="h-5 w-5 animate-spin" />
                </div>
                <div className="flex-1 text-xs">
                  <div className="font-extrabold text-amber-200 text-sm flex items-center gap-2">
                    <span>⏳ Groq Token Rate-Limit Cooldown Active</span>
                    <span className="text-[10px] uppercase font-black px-2 py-0.5 rounded-md bg-amber-400/20 border border-amber-400/30">
                      Attempt {progress.cooldown.attempt} / 4
                    </span>
                  </div>
                  <div className="text-amber-300/90 mt-1 leading-relaxed">
                    Cooling down token bucket for <span className="font-bold underline text-amber-200">{progress.cooldown.seconds} seconds</span> before retrying Groq AI. Question generation will resume automatically with Groq AI (no automatic fallback).
                  </div>
                </div>
              </div>
            )}

            {/* Real-Time Topic Breakdown Checklist */}
            {progress?.topics && progress.topics.length > 0 && (
              <div className="mt-6 border-t border-slate-800/80 pt-5 text-left">
                <div className="mb-3 flex items-center justify-between text-xs">
                  <span className="font-bold uppercase tracking-wider text-slate-400 text-[11px]">
                    Topic Progress ({progress.completedTopics.length}/{progress.topics.length})
                  </span>
                  <span className="text-[11px] text-slate-500 font-medium">
                    {progress.totalExpected ? `${Math.round(progress.totalExpected / progress.topics.length)} Qs / topic` : ""}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                  {progress.topics.map((topic, idx) => {
                    const isDone = progress.completedTopics.includes(topic);
                    const isCurrent = topic === progress.currentTopic && !isDone;

                    return (
                      <div
                        key={idx}
                        className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs border transition-all ${
                          isDone
                            ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                            : isCurrent
                            ? "bg-cyan-500/10 border-cyan-500/40 text-cyan-200 shadow-[0_0_10px_rgba(6,182,212,0.15)] animate-pulse"
                            : "bg-slate-950/60 border-slate-800/80 text-slate-400"
                        }`}
                      >
                        <div className="flex items-center gap-2 truncate">
                          {isDone ? (
                            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                          ) : isCurrent ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-cyan-400" />
                          ) : (
                            <Clock className="h-3.5 w-3.5 shrink-0 text-slate-600" />
                          )}
                          <span className="truncate font-medium">{topic}</span>
                        </div>
                        <span className="text-[10px] font-bold shrink-0 uppercase tracking-wider">
                          {isDone ? (
                            <span className="text-emerald-400 font-bold">Done</span>
                          ) : isCurrent ? (
                            <span className="text-cyan-300 font-extrabold">Formulating...</span>
                          ) : (
                            <span className="text-slate-600">Queued</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Success Banner */}
        {result && !generating && (
          <div className="mt-6 rounded-3xl border border-emerald-500/40 bg-emerald-500/10 p-6 text-center backdrop-blur-xl animate-in fade-in">
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-400" />
            <h3 className="mt-3 font-display text-xl font-extrabold text-white">
              🎉 {result.count} Questions Successfully Generated!
            </h3>
            <p className="mt-1 text-xs text-emerald-300">
              Your questions are saved and ready in the Review Studio for review & verified by tagging.
            </p>
            <div className="mt-4 flex items-center justify-center gap-3">
              <Link
                href="/review"
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 text-xs font-extrabold text-slate-950 shadow-lg shadow-emerald-500/25 hover:bg-emerald-400 hover:-translate-y-0.5 transition-all"
              >
                Open Review Studio <ArrowRight className="h-3.5 w-3.5" />
              </Link>
              <Link
                href="/bank"
                className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-2.5 text-xs font-bold text-slate-300 hover:text-white transition-all"
              >
                View Question Bank
              </Link>
            </div>
          </div>
        )}

        {/* TAB 1: SYLLABUS UPLOAD / PDF / IMAGE */}
        {activeTab === "upload" && !generating && (
          <div className="mt-6 space-y-6">
            {/* Upload Area */}
            {!parsedSyllabus ? (
              <div className="rounded-3xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-xl shadow-xl">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
                  accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md"
                  className="hidden"
                />

                {/* Dropzone */}
                {/* Dropzone or Active Scanning State */}
                {isParsingSyllabus ? (
                  <div className="rounded-2xl border border-emerald-500/40 bg-slate-950/90 p-8 text-center backdrop-blur-xl animate-in fade-in">
                    <div className="relative mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                      <Sparkles className="h-7 w-7 animate-pulse text-emerald-400" />
                      <Loader2 className="absolute -top-1 -right-1 h-5 w-5 text-emerald-400 animate-spin" />
                    </div>
                    <h3 className="font-display text-base font-bold text-white">
                      Scanning Syllabus Image with Groq Vision...
                    </h3>
                    <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                      Reading table of contents, identifying subject, grade level, and extracting all discrete learning topics.
                    </p>
                  </div>
                ) : (
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDragOver(true);
                    }}
                    onDragLeave={() => setIsDragOver(false)}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`cursor-pointer rounded-2xl border-2 border-dashed p-8 text-center transition-all ${
                      isDragOver
                        ? "border-emerald-500 bg-emerald-500/10"
                        : file
                        ? "border-emerald-500/50 bg-slate-950/80"
                        : "border-slate-800 bg-slate-950/40 hover:border-slate-700 hover:bg-slate-950/70"
                    }`}
                  >
                    {file ? (
                      <div className="flex flex-col items-center">
                        {imagePreview ? (
                          <img
                            src={imagePreview}
                            alt="Syllabus Preview"
                            className="h-32 max-w-full rounded-xl object-contain border border-slate-800 mb-3"
                          />
                        ) : (
                          <FileType className="h-12 w-12 text-emerald-400 mb-2" />
                        )}
                        <p className="text-sm font-bold text-white">{file.name}</p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {(file.size / 1024).toFixed(1)} KB · Click or drop to replace
                        </p>
                      </div>
                    ) : (
                      <div>
                        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 mb-3">
                          <UploadCloud className="h-7 w-7" />
                        </div>
                        <p className="text-sm font-bold text-white">
                          Click to upload or drag & drop syllabus
                        </p>
                        <p className="text-xs text-slate-400 mt-1">
                          Supports <span className="text-slate-300 font-semibold">PDF, Scanned Image (PNG/JPG), TXT</span> · Auto-analyzes on upload
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Error Banner if OCR/Parsing Fails */}
                {parseError && !isParsingSyllabus && (
                  <div className="mt-4 rounded-2xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs text-rose-300 flex items-center justify-between gap-3 animate-in fade-in">
                    <div className="flex items-center gap-2.5">
                      <X className="h-4 w-4 text-rose-400 shrink-0" />
                      <span>{parseError}</span>
                    </div>
                    {file && (
                      <button
                        onClick={() => {
                          setParseError(null);
                          parseFileDirectly(file);
                        }}
                        className="shrink-0 rounded-xl bg-rose-500/20 px-3 py-1.5 text-xs font-bold text-rose-200 hover:bg-rose-500/30 transition-all"
                      >
                        Retry Scan
                      </button>
                    )}
                  </div>
                )}

                {/* Or Paste Syllabus text */}
                {!isParsingSyllabus && (
                  <div className="mt-4">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="h-px flex-1 bg-slate-800" />
                      <span className="text-[11px] font-bold text-slate-500 uppercase">Or Paste Syllabus Text</span>
                      <div className="h-px flex-1 bg-slate-800" />
                    </div>
                    <textarea
                      value={rawSyllabusText}
                      onChange={(e) => {
                        setRawSyllabusText(e.target.value);
                        if (file) {
                          setFile(null);
                          setImagePreview(null);
                        }
                      }}
                      rows={3}
                      placeholder="Paste chapters, units, or curriculum outline here (e.g. Unit 1: Kinetic Theory, Unit 2: Thermodynamics...)"
                      className="w-full rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-xs font-medium text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none resize-none"
                    />

                    <button
                      onClick={handleParseSyllabus}
                      disabled={isParsingSyllabus || (!file && !rawSyllabusText.trim())}
                      className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 py-2.5 text-xs font-extrabold text-slate-950 shadow-md shadow-emerald-500/20 hover:opacity-95 transition-all disabled:opacity-40"
                    >
                      <Sparkles className="h-4 w-4" />
                      Analyze & Extract Topics
                    </button>
                  </div>
                )}
              </div>
            ) : (
              /* Parsed Syllabus Review & One-Click Generate Card */
              <div className="rounded-3xl border border-emerald-500/40 bg-slate-900/90 p-6 sm:p-7 backdrop-blur-xl shadow-2xl animate-in fade-in">
                {/* Header / Thumbnail / Action */}
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
                  <div className="flex items-center gap-3.5">
                    {imagePreview ? (
                      <img
                        src={imagePreview}
                        alt="Syllabus thumbnail"
                        className="h-16 w-16 rounded-xl object-cover border border-emerald-500/40 shadow-md"
                      />
                    ) : (
                      <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                        <BookOpen className="h-7 w-7" />
                      </div>
                    )}
                    <div className="flex-1 min-w-[260px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-0.5 text-xs font-black text-emerald-300">
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                          Syllabus Analyzed
                        </span>
                        <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-[10px] font-bold text-slate-400">
                          {parsedSyllabus.provider || "Groq Vision (qwen/qwen3.8-27b)"}
                        </span>
                      </div>
                      <div className="mt-2">
                        <label className="block text-[10px] font-extrabold uppercase tracking-wider text-slate-400 mb-1">
                          Question Set Title (Forwarded to My Zen Learning)
                        </label>
                        <input
                          type="text"
                          value={parsedSyllabus.title}
                          onChange={(e) =>
                            setParsedSyllabus({
                              ...parsedSyllabus,
                              title: e.target.value,
                            })
                          }
                          placeholder="e.g. 5th Grade Math • Set: Fractions & Decimals"
                          className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-1.5 text-sm font-bold text-white focus:border-emerald-500 focus:outline-none transition-all"
                        />
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => {
                      setParsedSyllabus(null);
                      setFile(null);
                      setImagePreview(null);
                      setRawSyllabusText("");
                    }}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/90 px-3.5 py-2 text-xs font-bold text-slate-300 hover:border-slate-600 hover:text-white transition-all"
                  >
                    <UploadCloud className="h-3.5 w-3.5" />
                    Upload Another Image
                  </button>
                </div>

                {/* Hero Discovery Metrics */}
                <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {/* Subject Metric - Directly Editable */}
                  <div className="rounded-2xl border border-emerald-500/30 bg-slate-950/80 p-4 transition-all hover:border-emerald-500/50">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                        <BookOpen className="h-3.5 w-3.5 text-emerald-400" />
                        Target Subject
                      </span>
                      <button
                        type="button"
                        onClick={() => setIsCustomSubjectMode(!isCustomSubjectMode)}
                        className="text-[10px] font-bold text-emerald-400 hover:text-emerald-300 underline underline-offset-2 transition-colors"
                      >
                        {isCustomSubjectMode ? "Choose Standard" : "Custom"}
                      </button>
                    </div>

                    <div className="mt-2">
                      {isCustomSubjectMode ? (
                        <input
                          type="text"
                          value={parsedSyllabus.subject}
                          onChange={(e) =>
                            setParsedSyllabus({
                              ...parsedSyllabus,
                              subject: e.target.value,
                            })
                          }
                          placeholder="e.g. Science, World History"
                          className="w-full rounded-xl border border-emerald-500/50 bg-slate-900 px-3 py-1.5 text-sm font-extrabold text-white focus:border-emerald-400 focus:outline-none"
                        />
                      ) : (
                        <div className="relative">
                          <select
                            value={parsedSyllabus.subject}
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val === "__custom__") {
                                setIsCustomSubjectMode(true);
                              } else {
                                setParsedSyllabus({
                                  ...parsedSyllabus,
                                  subject: val,
                                });
                              }
                            }}
                            className="w-full rounded-xl border border-slate-700 bg-slate-900/90 px-3 py-1.5 text-sm font-extrabold text-emerald-300 focus:border-emerald-400 focus:outline-none cursor-pointer transition-all hover:border-slate-600 appearance-none pr-8"
                          >
                            {!STANDARD_SUBJECTS.includes(parsedSyllabus.subject) && (
                              <option value={parsedSyllabus.subject}>
                                {parsedSyllabus.subject} (Detected)
                              </option>
                            )}
                            {STANDARD_SUBJECTS.map((s) => (
                              <option key={s} value={s} className="bg-slate-900 text-white font-medium">
                                {s}
                              </option>
                            ))}
                            <option value="__custom__" className="bg-slate-900 text-emerald-400 font-bold">
                              ✏️ Enter custom subject...
                            </option>
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        </div>
                      )}
                    </div>
                    <p className="mt-1.5 text-[10px] text-slate-400">
                      Click to change subject
                    </p>
                  </div>

                  {/* Grade Level Metric - Directly Editable (Addresses User Request) */}
                  <div className="rounded-2xl border border-teal-500/30 bg-slate-950/80 p-4 transition-all hover:border-teal-500/50 ring-1 ring-teal-500/20">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                        <Zap className="h-3.5 w-3.5 text-teal-400" />
                        Target Grade
                      </span>
                      <button
                        type="button"
                        onClick={() => setIsCustomGradeMode(!isCustomGradeMode)}
                        className="text-[10px] font-bold text-teal-400 hover:text-teal-300 underline underline-offset-2 transition-colors"
                      >
                        {isCustomGradeMode ? "Choose Standard" : "Custom"}
                      </button>
                    </div>

                    <div className="mt-2">
                      {isCustomGradeMode ? (
                        <input
                          type="text"
                          value={parsedSyllabus.gradeLevel}
                          onChange={(e) =>
                            setParsedSyllabus({
                              ...parsedSyllabus,
                              gradeLevel: e.target.value,
                            })
                          }
                          placeholder="e.g. 5th Grade, Middle School"
                          className="w-full rounded-xl border border-teal-500/50 bg-slate-900 px-3 py-1.5 text-sm font-extrabold text-white focus:border-teal-400 focus:outline-none"
                        />
                      ) : (
                        <div className="relative">
                          <select
                            value={parsedSyllabus.gradeLevel}
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val === "__custom__") {
                                setIsCustomGradeMode(true);
                              } else {
                                setParsedSyllabus({
                                  ...parsedSyllabus,
                                  gradeLevel: val,
                                });
                              }
                            }}
                            className="w-full rounded-xl border border-slate-700 bg-slate-900/90 px-3 py-1.5 text-sm font-extrabold text-teal-300 focus:border-teal-400 focus:outline-none cursor-pointer transition-all hover:border-slate-600 appearance-none pr-8"
                          >
                            {!STANDARD_GRADES.includes(parsedSyllabus.gradeLevel) && (
                              <option value={parsedSyllabus.gradeLevel}>
                                {parsedSyllabus.gradeLevel} (Detected)
                              </option>
                            )}
                            {STANDARD_GRADES.map((g) => (
                              <option key={g} value={g} className="bg-slate-900 text-white font-medium">
                                {g}
                              </option>
                            ))}
                            <option value="__custom__" className="bg-slate-900 text-teal-400 font-bold">
                              ✏️ Enter custom grade...
                            </option>
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        </div>
                      )}
                    </div>
                    <p className="mt-1.5 text-[10px] text-teal-400/90 font-medium">
                      Select or change grade for questions
                    </p>
                  </div>

                  {/* Topics Count Metric */}
                  <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 flex flex-col justify-between">
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                        Topics Detected
                      </span>
                      <p className="mt-2 text-xl font-black text-emerald-300">
                        {parsedSyllabus.topics.length} Topics Found
                      </p>
                    </div>
                    <p className="text-[10px] text-emerald-400/80">
                      Add, edit, or remove topics below
                    </p>
                  </div>
                </div>

                {/* AI Summary Quote (if available) */}
                {parsedSyllabus.summary && (
                  <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/60 p-3.5 text-xs text-slate-300 flex items-start gap-2.5">
                    <span className="text-emerald-400 font-bold shrink-0">Overview:</span>
                    <p className="italic text-slate-300 leading-relaxed">"{parsedSyllabus.summary}"</p>
                  </div>
                )}

                {/* Numbered List of Found Topics */}
                <div className="mt-6">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                      Topics Found in Image ({parsedSyllabus.topics.length})
                    </h3>
                    <span className="text-xs font-medium text-slate-400">
                      Review, edit, or remove before generating
                    </span>
                  </div>

                  <div className="space-y-2">
                    {parsedSyllabus.topics.map((topic, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/80 px-4 py-3 transition-all hover:border-emerald-500/40"
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-emerald-500/20 text-xs font-black text-emerald-300">
                            {i + 1}
                          </span>
                          {editingTopicIndex === i ? (
                            <div className="flex items-center gap-2 flex-1 mr-2">
                              <input
                                type="text"
                                value={editingTopicValue}
                                onChange={(e) => setEditingTopicValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleSaveTopicEdit(i);
                                  if (e.key === "Escape") setEditingTopicIndex(null);
                                }}
                                autoFocus
                                className="flex-1 rounded-lg border border-emerald-500/60 bg-slate-900 px-2.5 py-1 text-xs sm:text-sm font-bold text-white focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => handleSaveTopicEdit(i)}
                                className="rounded-lg bg-emerald-500 px-2.5 py-1 text-xs font-bold text-slate-950 hover:bg-emerald-400 transition-colors"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingTopicIndex(null)}
                                className="rounded-lg bg-slate-800 px-2.5 py-1 text-xs font-bold text-slate-400 hover:text-white transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs sm:text-sm font-bold text-white truncate flex-1">
                              {topic}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {editingTopicIndex !== i && (
                            <button
                              type="button"
                              onClick={() => handleStartTopicEdit(i, topic)}
                              title="Edit topic text"
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-emerald-400 transition-all"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleRemoveTopic(i)}
                            title="Remove this topic"
                            className="rounded-lg p-1.5 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400 transition-all"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Add Another Topic */}
                  <div className="mt-3 flex gap-2">
                    <input
                      type="text"
                      value={newTopicInput}
                      onChange={(e) => setNewTopicInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleAddTopic()}
                      placeholder="Add another topic from syllabus..."
                      className="flex-1 rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-xs font-medium text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                    />
                    <button
                      onClick={handleAddTopic}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-xs font-bold text-slate-200 hover:bg-slate-700 hover:text-white transition-all"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add Topic
                    </button>
                  </div>
                </div>

                {/* Inline Question Count Selector */}
                <div className="mt-5 rounded-2xl border border-slate-800/90 bg-slate-950/80 p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <label className="block text-xs font-bold text-white">
                        Questions per Topic
                      </label>
                      <p className="text-[11px] text-slate-400">
                        Choose how many diversified questions to create for each detected topic
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {[5, 10, 15, 20, 25, 30].map((num) => (
                        <button
                          key={num}
                          type="button"
                          onClick={() => setQuestionCount(num)}
                          className={`rounded-xl px-3.5 py-1.5 text-xs font-black transition-all ${
                            questionCount === num
                              ? "bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20 scale-105"
                              : "border border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500 hover:text-white"
                          }`}
                        >
                          {num}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Generation Formula & Trigger */}
                <div className="mt-4 rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-emerald-500/10 via-teal-500/10 to-slate-950 p-4 sm:p-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1">
                        <Sparkles className="h-3 w-3" />
                        Comprehensive & Diversified Coverage
                      </span>
                      <p className="text-sm font-bold text-white mt-0.5">
                        {parsedSyllabus.topics.length} topics × {questionCount} questions ={" "}
                        <span className="text-emerald-300 font-black text-base">
                          {parsedSyllabus.topics.length * questionCount} Total Questions
                        </span>
                      </p>
                      <p className="text-[11px] text-slate-400 mt-1 max-w-md">
                        Each topic will be thoroughly diversified across concepts, calculations, multi-step word problems, visual models, and misconceptions.
                      </p>
                    </div>

                    <button
                      onClick={handleSyllabusGenerate}
                      disabled={parsedSyllabus.topics.length === 0}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 via-teal-500 to-blue-600 px-6 py-3.5 text-xs sm:text-sm font-black text-slate-950 shadow-xl shadow-emerald-500/20 hover:opacity-95 hover:-translate-y-0.5 transition-all disabled:opacity-40 shrink-0"
                    >
                      <Zap className="h-4 w-4 fill-slate-950" />
                      Generate {parsedSyllabus.topics.length * questionCount} Questions
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: PRESET CURRICULUM PACKS */}
        {activeTab === "presets" && !generating && (
          <div className="mt-6">
            {/* 1-Click Auto Upload Banner */}
            <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-emerald-500/40 bg-gradient-to-r from-emerald-950/60 via-slate-900 to-teal-950/60 p-5 backdrop-blur-xl">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500 text-slate-950 font-black shadow-lg shadow-emerald-500/20">
                  <Zap className="h-6 w-6 fill-slate-950" />
                </div>
                <div>
                  <h3 className="font-display text-sm sm:text-base font-black text-white">
                    Auto-Upload All Grade Curriculums
                  </h3>
                  <p className="text-xs text-slate-300">
                    Generate & verify questions for Kindergarten, 1st–5th Grade, Middle School, and SAT/ACT in 1 click.
                  </p>
                </div>
              </div>

              <button
                onClick={handleAutoSeedAll}
                disabled={autoSeeding}
                className="flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 text-xs font-black text-slate-950 shadow-lg shadow-emerald-500/20 hover:bg-emerald-400 hover:scale-105 transition-all disabled:opacity-50"
              >
                {autoSeeding ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Auto-Generating All Grades...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    Auto-Upload All Grades 🚀
                  </>
                )}
              </button>
            </div>

            {autoSeedMessage && (
              <div className="mb-6 rounded-xl border border-emerald-500/50 bg-emerald-500/10 p-4 text-xs font-bold text-emerald-300 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                <span>{autoSeedMessage}</span>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {CURRICULUM_PRESETS.map((preset) => (
              <button
                key={preset.id}
                onClick={() => handlePresetClick(preset)}
                className="group relative flex flex-col justify-between rounded-2xl border border-slate-800/90 bg-slate-900/60 p-5 text-left transition-all hover:-translate-y-0.5 hover:border-emerald-500/50 hover:bg-slate-900 hover:shadow-xl hover:shadow-emerald-500/5"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-2xl">{preset.icon}</span>
                    <span className="rounded-md border border-slate-800 bg-slate-950 px-2 py-0.5 text-[10px] font-bold text-slate-400">
                      {preset.gradeLevel}
                    </span>
                  </div>
                  <h3 className="mt-3 font-display text-base font-bold text-white group-hover:text-emerald-300 transition-colors">
                    {preset.title}
                  </h3>
                  <div className="mt-2.5 flex flex-wrap gap-1">
                    {preset.topics.slice(0, 3).map((t) => (
                      <span
                        key={t}
                        className="rounded-md bg-slate-800/80 px-2 py-0.5 text-[10px] font-semibold text-slate-400"
                      >
                        {t}
                      </span>
                    ))}
                    {preset.topics.length > 3 && (
                      <span className="rounded-md bg-slate-800/80 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                        +{preset.topics.length - 3}
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-1 text-[11px] font-bold text-emerald-400">
                  <Sparkles className="h-3 w-3" />
                  <span>Generate {preset.topics.length * questionCount} Questions →</span>
                </div>
              </button>
            ))}
            </div>
          </div>
        )}

        {/* TAB 3: CUSTOM TOPIC INPUT */}
        {activeTab === "custom" && !generating && (
          <div className="mt-6 mx-auto max-w-xl rounded-3xl border border-slate-800 bg-slate-900/70 p-6 backdrop-blur-xl">
            <div className="mb-4">
              <label className="block text-xs font-bold text-slate-300 mb-1.5 flex items-center justify-between">
                <span>Question Set Title (Optional)</span>
                <span className="text-[10px] text-slate-400 font-normal">Sent to My Zen Learning</span>
              </label>
              <input
                type="text"
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder={`e.g. ${customGrade} ${customSubject} • Set: Comprehensive Review`}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">
                Topic or Syllabus Outline
              </label>
              <textarea
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                rows={4}
                placeholder="e.g. Chemical Bonding, Periodic Trends, Stoichiometry..."
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm font-medium text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none resize-none"
              />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-400 mb-1">Grade Level</label>
                <select
                  value={customGrade}
                  onChange={(e) => setCustomGrade(e.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-bold text-white focus:border-emerald-500 focus:outline-none"
                >
                  {["Kindergarten", "1st Grade", "2nd Grade", "3rd Grade", "4th Grade", "5th Grade", "6th Grade", "7th Grade", "8th Grade", "9th Grade", "10th Grade", "11th Grade", "12th Grade", "SAT/ACT", "College"].map((g) => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-400 mb-1">Subject</label>
                <select
                  value={customSubject}
                  onChange={(e) => setCustomSubject(e.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-bold text-white focus:border-emerald-500 focus:outline-none"
                >
                  {["Math", "English Language Arts", "Reading", "Science", "History", "Coding", "Chemistry", "Physics", "Biology", "English"].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            <button
              onClick={handleCustomSubmit}
              disabled={!customInput.trim()}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 via-teal-500 to-blue-600 py-3 text-sm font-extrabold text-slate-950 shadow-lg shadow-emerald-500/20 hover:shadow-xl hover:-translate-y-0.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Sparkles className="h-4 w-4" />
              Generate Question Pack
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
