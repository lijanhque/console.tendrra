import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local", override: true });
import express from "express";
import cors from "cors";
import { prisma } from "@repo/database";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { convertToModelMessages, generateText, stepCountIs, streamText } from "ai";
import { z } from "zod";

// Route Imports
import webhookRouter from "./routes/webhooks.js";
import researchRouter from "./routes/research.js";
import workflowRouter from "./routes/workflows.js";
import taskRouter from "./routes/tasks.js";
import logRouter from "./routes/logs.js";
import jobRouter from "./routes/jobs.js";
import userRouter from "./routes/users.js";
import agentRouter from "./routes/agents/index.js";
import mcpRouter from "./routes/mcp/index.js";
import connectorRouter from "./routes/connectors.js";
import messageRouter from "./routes/messages.js";
import { webSearch } from "@exalabs/ai-sdk";
import { sandboxTool } from "./tools/sandbox.js";
// Middleware & Lib Imports
import { auditLogger } from "./middleware/logger.js";
import { authenticate } from "./middleware/auth.js";
import { registerJobHandler } from "./lib/job-queue.js";
import { executeWorkflow } from "./lib/workflow-engine.js";
import { executeAgentTask } from "./lib/agent-runner.js";
import { deepResearch } from "./lib/parallel.js";

import path from "path";
import { fileURLToPath } from "url";

if (!process.env.OPENROUTER_API_KEY) {
  console.warn("⚠️  OPENROUTER_API_KEY is not set in environment variables.");
}
if (!process.env.EXA_API_KEY) {
  console.warn("⚠️  EXA_API_KEY is not set in environment variables (needed for web search).");
}
if (!process.env.DAYTONA_API_KEY) {
  console.warn("⚠️  DAYTONA_API_KEY is not set in environment variables (needed for code sandbox).");
}

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY || undefined,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serve documentation
app.get("/docs", (req, res) => {
  res.sendFile(path.join(process.cwd(), "docs.html"));
});



// Register Background Handlers
registerJobHandler("WORKFLOW_EXECUTION", async (payload) => {
  return await executeWorkflow(payload.workflowId, payload.inputData);
});

registerJobHandler("AGENT_TASK", async (payload) => {
  return await executeAgentTask(payload.agentId, payload.task);
});

registerJobHandler("DEEP_RESEARCH", async (payload) => {
  return await deepResearch(payload.objective);
});

// Middleware
app.use(cors({
  origin: [
    "http://localhost:3024",
    "http://localhost:3000",
    "https://glowing-lamp-q7vq9wg7g5pj24p9g-3001.app.github.dev",
    process.env.DASHBOARD_URL ?? "",
  ].filter(Boolean),
  credentials: true,
}));
app.use(auditLogger);

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "tendrra-api",
    version: "1.0.0",
  });
});

// Modular Routes
app.use("/api/webhooks", webhookRouter);
app.use("/api/research", researchRouter);
app.use("/api/workflows", workflowRouter);
app.use("/api/tasks", taskRouter);
app.use("/api/logs", logRouter);
app.use("/api/jobs", jobRouter);
app.use("/api/messages", messageRouter);
app.use("/api/users", userRouter);
app.use("/api/agents", authenticate, agentRouter);
app.use("/api/connectors", authenticate, connectorRouter);
app.use("/api/mcp", mcpRouter);

// Test Logs Mock Data Route
app.get("/api/test-logs", (req, res) => {
  res.json([
    { id: "a7b3c9d1", agent: "Agent-1", task: "Task execution complete", status: "Success", time: "10:23:45", duration: "125ms" },
    { id: "e2f5a8b4", agent: "Agent-3", task: "Processing request", status: "Running", time: "10:23:42", duration: "89ms" },
    { id: "c9d4e7f2", agent: "System", task: "Health check", status: "Success", time: "10:23:40", duration: "45ms" },
    { id: "b1a6c3d5", agent: "Agent-2", task: "Data validation", status: "Failed", time: "10:23:38", duration: "234ms" },
    { id: "f8e2d9a7", agent: "Agent-1", task: "Memory cleanup", status: "Success", time: "10:23:35", duration: "67ms" },
  ]);
});

// AI SDK Chat Endpoint
app.post("/api/chat", async (req, res) => {
  const { messages, model: modelId, id: chatId } = req.body;
  const selectedModel = modelId ?? "openrouter/free";

  try {
    // useChat sends UIMessages (with `parts`); convert to CoreMessages for streamText
    const coreMessages = await convertToModelMessages(messages);

    const result = streamText({
      model: openrouter.chat(selectedModel),
      messages: coreMessages,
      system:
        "You are a helpful AI assistant for WorldAutomate — an enterprise automation platform. " +
        "You are agentic and have access to powerful tools: " +
        "1. webSearch: Use this to find real-time, up-to-date information. " +
        "2. sandbox: Use this to execute code (TypeScript, Python) or shell commands. This is perfect for calculations, data processing, or building and testing software artifacts. " +
        "CRITICAL: Always keep your output with current, up-to-date data. If asked about recent events, companies, or anything time-sensitive, ALWAYS use the webSearch tool to retrieve the latest information rather than relying on your training data. " +
        "Before answering, you must ALWAYS think step-by-step and write your internal reasoning inside <thought> and </thought> XML tags. After the </thought> tag, provide your final response to the user. " +
        "Be concise, helpful, and proactive. When you use tools, explain what you are doing and summarize the results clearly.",
      tools: {
        webSearch: webSearch(),
        sandbox: sandboxTool,
      },
      stopWhen: stepCountIs(5),
    });

    const webResponse = result.toUIMessageStreamResponse({
      originalMessages: messages,
      onFinish: async ({ messages: completedMessages }) => {
        if (!chatId) return;
        try {
          // Use a default user if req.user is not available
          const userId = (req as any).user?.id || "temp-user-id";
          
          await prisma.chat.upsert({
            where: { id: chatId },
            update: { messages: completedMessages as any },
            create: {
              id: chatId,
              title: "New Chat",
              userId: userId,
              messages: completedMessages as any,
            }
          });

          await prisma.activityLog.create({
            data: {
              userId: userId,
              actionType: "CHAT_MESSAGE",
              description: `Chat message added to ${chatId}`
            }
          });
        } catch (error) {
          console.error("Save chat error:", error);
        }
      }
    });

    result.consumeStream();

    if (webResponse.headers) {
      webResponse.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
    }

    import("stream").then(({ Readable }) => {
      if (webResponse.body) {
        Readable.fromWeb(webResponse.body as any).pipe(res);
      }
    });

  } catch (error) {
    console.error("AI Chat Error:", error);
    res.status(500).json({ error: "Failed to process AI request" });
  }
});

app.get("/api/chat/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const chat = await prisma.chat.findUnique({
      where: { id },
    });
    
    if (!chat) {
      return res.status(404).json({ error: "Chat not found" });
    }
    
    res.json(chat);
  } catch (error) {
    console.error("Error fetching chat:", error);
    res.status(500).json({ error: "Failed to fetch chat" });
  }
});

// Fetch Activity Logs
app.get("/api/activity-logs", async (req, res) => {
  const mockLogs = [
    { id: "a7b3c9d1", agent: "Agent-1", task: "Task execution complete", status: "Success", time: "10:23:45", duration: "125ms" },
    { id: "e2f5a8b4", agent: "Agent-3", task: "Processing request", status: "Running", time: "10:23:42", duration: "89ms" },
    { id: "c9d4e7f2", agent: "System", task: "Health check", status: "Success", time: "10:23:40", duration: "45ms" },
    { id: "b1a6c3d5", agent: "Agent-2", task: "Data validation", status: "Failed", time: "10:23:38", duration: "234ms" },
    { id: "f8e2d9a7", agent: "Agent-1", task: "Memory cleanup", status: "Success", time: "10:23:35", duration: "67ms" },
  ];
  res.json(mockLogs);
});

// AI Suggestions Endpoint
app.post("/api/chat/suggestions", async (req, res) => {
  const { lastAssistantMessage } = req.body;

  if (!lastAssistantMessage) {
    return res.json({ suggestions: [] });
  }

  try {
    const result = await generateText({
      model: openrouter.chat("openrouter/free"),
      system:
        "You are a follow-up suggestion generator for an AI chat interface. " +
        "Given the AI's last response, generate exactly 4 short, relevant follow-up questions or actions the user might want to do next. " +
        "Each suggestion must be under 60 characters. " +
        "Return ONLY a JSON array of 4 strings, nothing else. Example: [\"Tell me more\", \"Show me an example\", \"How does this work?\", \"What are the alternatives?\"]",
      prompt: `AI's last response:\n\n${lastAssistantMessage.slice(0, 1000)}\n\nGenerate 4 follow-up suggestions as a JSON array.`,
    });

    let suggestions: string[] = [];
    try {
      const cleaned = result.text
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      suggestions = JSON.parse(cleaned);
      if (!Array.isArray(suggestions)) suggestions = [];
    } catch {
      suggestions = [];
    }

    res.json({ suggestions: suggestions.slice(0, 4) });
  } catch (error) {
    console.error("Suggestions error:", error);
    res.json({ suggestions: [] });
  }
});

export const tendrraApi = app;

if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 3001;
  app.listen(port, () => {
    console.log(`Advanced API server listening on port ${port}`);
  });
}
