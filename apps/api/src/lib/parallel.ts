import Parallel from "parallel-web";

let client: Parallel | null = null;

function getClient(): Parallel {
  const key = process.env.PARALLEL_API_KEY;
  if (!key) {
    throw new Error("PARALLEL_API_KEY is not set");
  }
  if (!client) {
    client = new Parallel({ apiKey: key });
  }
  return client;
}

export interface ResearchOptions {
  iterations?: number;
  extractContent?: boolean;
  maxSources?: number;
  includeImages?: boolean;
}

export async function search(objective: string, queries: string[]) {
  return await getClient().search({
    objective,
    search_queries: queries,
  });
}

export async function extract(url: string, objective: string, schema?: any) {
  return await getClient().search({
    objective: `Extract ${objective} from ${url}`,
    search_queries: [url],
  });
}

export async function deepResearch(objective: string, options: ResearchOptions = {}) {
  const { iterations = 3, maxSources = 10 } = options;

  console.log(`Starting deep research for: ${objective}`);

  const allResults: any[] = [];
  const queryChain: string[] = [objective];

  let currentObjective = objective;
  let sources: any[] = [];

  for (let i = 0; i < iterations; i++) {
    const searchResults = await getClient().search({
      objective: `Gather comprehensive information step ${i + 1}/${iterations} for: ${currentObjective}`,
      search_queries: [currentObjective],
    });

    allResults.push(searchResults);

    if (searchResults.results && searchResults.results.length > 0) {
      sources = [...sources, ...searchResults.results];
      currentObjective = generateFollowUpQuery(searchResults, objective, i);
    }
  }

  const uniqueSources = deduplicateSources(sources).slice(0, maxSources);

  return {
    objective,
    iterations,
    search_id: `deep-${Date.now()}`,
    results: uniqueSources,
    queryChain,
    summary: synthesizeFindings(uniqueSources, objective),
  };
}

function generateFollowUpQuery(results: any, originalObjective: string, step: number): string {
  if (!results?.results?.length) return originalObjective;

  const keyTopics = results.results
    .flatMap((r: any) => r.excerpts || [])
    .join(" ")
    .split(/\s+/)
    .filter((w: string) => w.length > 5)
    .slice(0, 10);

  return step < 2 ? `${originalObjective} analysis of ${keyTopics.slice(0, 3).join(" ")}` : originalObjective;
}

function deduplicateSources(sources: any[]): any[] {
  const seen = new Set();
  return sources.filter((s: any) => {
    const key = s.url || s.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function synthesizeFindings(sources: any[], objective: string): string {
  const keyPoints = sources
    .flatMap((s: any) => s.excerpts || [])
    .slice(0, 20)
    .map((e: string) => e.substring(0, 200))
    .join("\n\n");

  return `Research Summary for: ${objective}\n\nKey Findings:\n${keyPoints}`;
}
