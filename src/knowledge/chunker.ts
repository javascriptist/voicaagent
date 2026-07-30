/**
 * Chunking for retrieval.
 *
 * Target is roughly 300 tokens with 50 tokens of overlap, split on heading
 * boundaries where possible. The heading rule matters more than the size: a
 * policy document cut in the middle of "Cancellations" produces two chunks
 * that each half-answer the question, and the reranker cannot repair that.
 *
 * Token counts are estimated, not tokenised. Voyage's tokeniser is not
 * available locally, and being 15% out on chunk size costs nothing — being
 * wrong about where a section starts costs an answer.
 */

export interface Chunk {
  title: string;
  content: string;
  tokenCount: number;
  index: number;
}

export interface ChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
  /** Falls back to this when a section has no heading of its own. */
  documentTitle: string;
}

const DEFAULT_TARGET = 300;
const DEFAULT_OVERLAP = 50;

/**
 * ~4 characters per token for English prose, the widely used approximation for
 * BPE tokenisers. Deliberately conservative: overestimating token count makes
 * chunks smaller, which is the safe direction for an embedding context limit.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

interface Section {
  heading: string | null;
  body: string;
}

/** Split on markdown headings, and on ALL CAPS lines, which admins type a lot. */
function splitIntoSections(text: string, documentTitle: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body.length > 0 || heading) sections.push({ heading, body });
    buffer = [];
  };

  for (const line of lines) {
    const markdown = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    const shouty = /^([A-Z][A-Z0-9 '&/-]{3,60})$/.exec(line.trim());
    if (markdown) {
      flush();
      heading = markdown[2]!;
      continue;
    }
    if (shouty && buffer.join('').trim().length > 0) {
      flush();
      heading = shouty[1]!.trim();
      continue;
    }
    buffer.push(line);
  }
  flush();

  if (sections.length === 0) return [{ heading: documentTitle, body: text.trim() }];
  return sections;
}

function splitSentences(text: string): string[] {
  // Paragraph first, then sentence. Keeping paragraphs whole means a bulleted
  // list of allergens stays in one chunk.
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    if (estimateTokens(paragraph) <= DEFAULT_TARGET) {
      out.push(paragraph.trim());
      continue;
    }
    const sentences = paragraph.match(/[^.!?\n]+[.!?]*\s*/g) ?? [paragraph];
    for (const s of sentences) if (s.trim()) out.push(s.trim());
  }
  return out;
}

export function chunkDocument(text: string, options: ChunkOptions): Chunk[] {
  const target = options.targetTokens ?? DEFAULT_TARGET;
  const overlap = options.overlapTokens ?? DEFAULT_OVERLAP;
  const sections = splitIntoSections(text, options.documentTitle);

  const chunks: Chunk[] = [];
  let index = 0;

  for (const section of sections) {
    const title = section.heading ?? options.documentTitle;
    const pieces = splitSentences(section.body);
    if (pieces.length === 0) continue;

    let current: string[] = [];
    let currentTokens = 0;

    const emit = () => {
      if (current.length === 0) return;
      const content = current.join('\n\n').trim();
      if (content.length === 0) return;
      chunks.push({
        // The heading is prepended to the embedded text so "step free access"
        // matches a chunk whose body says only "yes, via the side entrance".
        title,
        content: section.heading ? `${title}\n\n${content}` : content,
        tokenCount: estimateTokens(content),
        index: index++,
      });
    };

    for (const piece of pieces) {
      const tokens = estimateTokens(piece);
      if (currentTokens + tokens > target && current.length > 0) {
        emit();
        // Carry the tail of the previous chunk forward, so a fact split across
        // the boundary is retrievable from either side.
        const carried: string[] = [];
        let carriedTokens = 0;
        for (let i = current.length - 1; i >= 0 && carriedTokens < overlap; i--) {
          carried.unshift(current[i]!);
          carriedTokens += estimateTokens(current[i]!);
        }
        current = carried;
        currentTokens = carriedTokens;
      }
      current.push(piece);
      currentTokens += tokens;
    }
    emit();
  }

  return chunks;
}
