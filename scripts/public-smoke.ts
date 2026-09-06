import { BrowserService } from '../src/server/browser';
import type { DetectionCandidate, ExtractedItem } from '../src/shared/types';

type SmokeTarget = {
  name: string;
  url: string;
  waitForSelector?: string;
};

type SmokeResult = {
  name: string;
  url: string;
  pageUrl?: string;
  pageTitle?: string;
  candidates?: Array<{
    id: string;
    label: string;
    confidence: DetectionCandidate['confidence'];
    score: number;
    count: number;
    sampleTitles: string[];
    sampleLinks: string[];
    fields: {
      title: number;
      link: number;
      description: number;
      image: number;
      date: number;
    };
    warnings: string[];
  }>;
  recommendedId?: string | null;
  warnings?: string[];
  error?: string;
};

const targets: SmokeTarget[] = [
  {
    name: 'Hacker News',
    url: 'https://news.ycombinator.com/news',
    waitForSelector: 'tr.athing',
  },
  {
    name: 'GitHub Changelog',
    url: 'https://github.blog/changelog/',
  },
  {
    name: 'Chrome for Developers Blog',
    url: 'https://developer.chrome.com/blog/',
  },
];

function fieldCoverage(items: ExtractedItem[]): NonNullable<SmokeResult['candidates']>[number]['fields'] {
  const total = items.length || 1;
  return {
    title: items.filter(item => Boolean(item.title)).length / total,
    link: items.filter(item => Boolean(item.link)).length / total,
    description: items.filter(item => Boolean(item.description)).length / total,
    image: items.filter(item => Boolean(item.image)).length / total,
    date: items.filter(item => Boolean(item.publishedAt)).length / total,
  };
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function main(): Promise<void> {
  const service = new BrowserService();
  const results: SmokeResult[] = [];
  try {
    for (const target of targets) {
      let sessionId: string | undefined;
      try {
        const frame = await service.open({ url: target.url, waitMs: 1_500, waitForSelector: target.waitForSelector });
        sessionId = frame.sessionId;
        const detection = await service.detect(sessionId);
        const candidates = detection.candidates.map(candidate => ({
          id: candidate.id,
          label: candidate.label,
          confidence: candidate.confidence,
          score: Number(candidate.score.toFixed(3)),
          count: candidate.count,
          sampleTitles: candidate.items.slice(0, 3).map(item => item.title).filter(Boolean),
          sampleLinks: candidate.items.slice(0, 3).map(item => item.link).filter(Boolean),
          fields: fieldCoverage(candidate.items),
          warnings: candidate.warnings.slice(0, 5),
        }));
        results.push({
          name: target.name,
          url: target.url,
          pageUrl: frame.url,
          pageTitle: frame.title,
          candidates,
          recommendedId: detection.recommendedId,
          warnings: detection.warnings.slice(0, 8),
        });
      } catch (error) {
        results.push({ name: target.name, url: target.url, error: compactError(error) });
      } finally {
        if (sessionId) await service.close(sessionId).catch(() => undefined);
      }
    }
  } finally {
    await service.dispose();
  }
  process.stdout.write(`${JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${compactError(error)}\n`);
  process.exitCode = 1;
});
