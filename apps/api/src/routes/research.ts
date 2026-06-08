import { Router } from "express";
import { search, extract, deepResearch } from "../lib/parallel.js";
import { prisma } from "@repo/database";
import { createJob } from "../lib/job-queue.js";

const router = Router();

router.post("/search", async (req, res) => {
  const { objective, queries, userId } = req.body;
  try {
    const startTime = Date.now();
    const results = await search(objective, queries);
    const durationMs = Date.now() - startTime;

    if (userId) {
      await prisma.researchArtifact.create({
        data: {
          userId,
          objective,
          type: "SEARCH",
          status: "COMPLETED",
          results,
          durationMs,
          sourceCount: results.results?.length ?? 0,
          queryChain: queries,
        },
      });

      await prisma.activityLog.create({
        data: {
          userId,
          actionType: "RESEARCH_SEARCH",
          description: `Performed search: ${objective.substring(0, 50)}...`,
        },
      });
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.post("/extract", async (req, res) => {
  const { url, objective, userId } = req.body;
  try {
    const startTime = Date.now();
    const results = await extract(url, objective);
    const durationMs = Date.now() - startTime;

    if (userId) {
      await prisma.researchArtifact.create({
        data: {
          userId,
          objective,
          type: "EXTRACT",
          status: "COMPLETED",
          results,
          durationMs,
          sourceCount: 1,
          queryChain: [url],
        },
      });

      await prisma.activityLog.create({
        data: {
          userId,
          actionType: "RESEARCH_EXTRACT",
          description: `Extracted data from: ${url.substring(0, 50)}...`,
        },
      });
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.post("/deep-research", async (req, res) => {
  const { objective, userId, async } = req.body;
  try {
    if (async) {
      if (!userId) return res.status(400).json({ error: "userId required for async runs" });

      const job = await createJob("DEEP_RESEARCH", { objective }, userId);

      return res.status(202).json({ jobId: job.id, status: job.status });
    }

    const startTime = Date.now();
    const results = await deepResearch(objective);
    const durationMs = Date.now() - startTime;

    if (userId) {
      await prisma.researchArtifact.create({
        data: {
          userId,
          objective,
          type: "DEEP_RESEARCH",
          status: "COMPLETED",
          results,
          durationMs,
          sourceCount: results.results?.length ?? 0,
          queryChain: [objective],
        },
      });

      await prisma.activityLog.create({
        data: {
          userId,
          actionType: "RESEARCH_DEEP",
          description: `Performed deep research: ${objective.substring(0, 50)}...`,
        },
      });
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.get("/history", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });

  try {
    const history = await prisma.researchArtifact.findMany({
      where: { userId: String(userId) },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    res.json(history);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.get("/artifacts/:id", async (req, res) => {
  const { id } = req.params;
  const { userId } = req.query;

  try {
    const artifact = await prisma.researchArtifact.findFirst({
      where: { id, userId: String(userId) },
    });

    if (!artifact) return res.status(404).json({ error: "Artifact not found" });

    res.json(artifact);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

export default router;
