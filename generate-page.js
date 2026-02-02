import fetch from 'node-fetch';
import fs from 'fs';
import { EOL } from 'os';

const ARCHIVE_DIR = 'archives';
const SEEN_FILE = `${ARCHIVE_DIR}/seen-items.json`;
const MAX_ITEMS_TOTAL = 18;
const MAX_ITEMS_PER_SOURCE = 5;
const ENRICH_LIMIT = 12;
const MIN_ITEMS_TOTAL = 6;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const FORCE_DATE = process.env.FORCE_DATE;

function logDebug(...args) {
  if (DEBUG) {
    console.log('[debug]', ...args);
  }
}

const SOURCES = [
  {
    id: 'hf_papers',
    name: 'Hugging Face Papers',
    url: 'https://huggingface.co/papers',
    type: 'paper',
    parser: parseHuggingFacePapers,
  },
  {
    id: 'arxiv_cv',
    name: 'arXiv cs.CV (recent)',
    url: 'https://export.arxiv.org/api/query?search_query=cat:cs.CV&sortBy=lastUpdatedDate&sortOrder=descending&max_results=10',
    type: 'paper',
    parser: parseArxivFeed,
  },
  {
    id: 'paperswithcode',
    name: 'Papers with Code',
    url: 'https://paperswithcode.com/',
    type: 'paper',
    parser: parsePapersWithCode,
  },
  {
    id: 'google_research_blog',
    name: 'Google Research Blog',
    url: 'https://research.google/blog/',
    type: 'news',
    parser: parseGoogleResearchBlog,
  },
  {
    id: 'microsoft_research_blog',
    name: 'Microsoft Research Blog',
    url: 'https://www.microsoft.com/en-us/research/blog/',
    type: 'news',
    parser: parseMicrosoftResearchBlog,
  },
  {
    id: 'qualcomm_ai',
    name: 'Qualcomm AI Research',
    url: 'https://www.qualcomm.com/research/artificial-intelligence',
    type: 'news',
    parser: parseQualcommAI,
  },
  {
    id: 'google_ai_edge',
    name: 'Google AI Edge',
    url: 'https://ai.google.dev/edge',
    type: 'news',
    parser: parseSinglePageTitle,
  },
  {
    id: 'open_vlm_leaderboard',
    name: 'Open VLM Leaderboard',
    url: 'https://huggingface.co/spaces/opencompass/open_vlm_leaderboard',
    type: 'news',
    parser: parseSinglePageTitle,
  },
];

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(value) {
  return decodeHtml(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractAnchors(html) {
  const anchors = [];
  const regex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    anchors.push({ href: match[1], text: stripTags(match[2]) });
  }
  return anchors;
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(match[1]) : '';
}

function extractMetaDescription(html) {
  const match = html.match(/<meta\s+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || html.match(/<meta\s+property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  return match ? stripTags(match[1]) : '';
}

function loadSeen() {
  if (!fs.existsSync(SEEN_FILE)) {
    return { version: 1, updatedAt: null, items: {} };
  }
  try {
    const raw = fs.readFileSync(SEEN_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    console.warn('seen-items.json 파싱 실패, 새로 생성합니다.', error);
    return { version: 1, updatedAt: null, items: {} };
  }
}

function saveSeen(seen) {
  seen.updatedAt = new Date().toISOString().split('T')[0];
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

function pruneSeen(seen, keepDays = 180) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  Object.entries(seen.items).forEach(([url, meta]) => {
    if (meta.lastSeen && meta.lastSeen < cutoffStr) {
      delete seen.items[url];
    }
  });
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  logDebug('fetch:start', url);
  const response = await fetch(url, {
    signal: controller.signal,
    headers: {
      'User-Agent': 'ai-daily-trends-bot/1.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
  clearTimeout(timeoutId);
  if (!response.ok) {
    logDebug('fetch:fail', url, response.status);
    throw new Error(`Fetch error ${response.status} for ${url}`);
  }
  logDebug('fetch:ok', url);
  return response.text();
}

function parseHuggingFacePapers(html, source) {
  const anchors = extractAnchors(html);
  const items = [];
  const seen = new Set();
  for (const anchor of anchors) {
    if (!anchor.href.startsWith('/papers/')) continue;
    if (anchor.href.includes('#')) continue;
    const url = `https://huggingface.co${anchor.href}`;
    const title = anchor.text;
    if (!title || title.length < 8) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({
      title,
      url,
      sourceId: source.id,
      sourceName: source.name,
      type: source.type,
    });
  }
  return items.slice(0, MAX_ITEMS_PER_SOURCE);
}

function parseArxivFeed(xml, source) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];
  const items = entries.slice(0, MAX_ITEMS_PER_SOURCE).map((entryMatch) => {
    const entry = entryMatch[1];
    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/i);
    const idMatch = entry.match(/<id>([\s\S]*?)<\/id>/i);
    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/i);
    return {
      title: stripTags(titleMatch ? titleMatch[1] : ''),
      url: stripTags(idMatch ? idMatch[1] : ''),
      snippet: stripTags(summaryMatch ? summaryMatch[1] : ''),
      sourceId: source.id,
      sourceName: source.name,
      type: source.type,
    };
  });
  return items.filter(item => item.title && item.url);
}

function parsePapersWithCode(html, source) {
  const anchors = extractAnchors(html);
  const items = [];
  const seen = new Set();
  for (const anchor of anchors) {
    if (!anchor.href.startsWith('/paper/')) continue;
    const url = `https://paperswithcode.com${anchor.href}`;
    const title = anchor.text;
    if (!title || title.length < 8) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({
      title,
      url,
      sourceId: source.id,
      sourceName: source.name,
      type: source.type,
    });
  }
  return items.slice(0, MAX_ITEMS_PER_SOURCE);
}

function parseGoogleResearchBlog(html, source) {
  const anchors = extractAnchors(html);
  const items = [];
  const seen = new Set();
  for (const anchor of anchors) {
    if (!anchor.href.startsWith('/blog/') && !anchor.href.startsWith('https://research.google/blog/')) continue;
    const url = anchor.href.startsWith('http') ? anchor.href : `https://research.google${anchor.href}`;
    const title = anchor.text;
    if (!title || title.length < 8) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({
      title,
      url,
      sourceId: source.id,
      sourceName: source.name,
      type: source.type,
    });
  }
  return items.slice(0, MAX_ITEMS_PER_SOURCE);
}

function parseMicrosoftResearchBlog(html, source) {
  const anchors = extractAnchors(html);
  const items = [];
  const seen = new Set();
  for (const anchor of anchors) {
    if (!anchor.href.includes('/research/blog/')) continue;
    const url = anchor.href.startsWith('http') ? anchor.href : `https://www.microsoft.com${anchor.href}`;
    const title = anchor.text;
    if (!title || title.length < 8) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({
      title,
      url,
      sourceId: source.id,
      sourceName: source.name,
      type: source.type,
    });
  }
  return items.slice(0, MAX_ITEMS_PER_SOURCE);
}

function parseQualcommAI(html, source) {
  const anchors = extractAnchors(html);
  const items = [];
  const seen = new Set();
  for (const anchor of anchors) {
    if (!anchor.href.includes('/research/')) continue;
    const url = anchor.href.startsWith('http') ? anchor.href : `https://www.qualcomm.com${anchor.href}`;
    const title = anchor.text;
    if (!title || title.length < 8) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({
      title,
      url,
      sourceId: source.id,
      sourceName: source.name,
      type: source.type,
    });
  }
  return items.slice(0, MAX_ITEMS_PER_SOURCE);
}

function parseSinglePageTitle(html, source) {
  const title = extractTitle(html) || source.name;
  return [{
    title,
    url: source.url,
    sourceId: source.id,
    sourceName: source.name,
    type: source.type,
  }];
}

async function enrichItems(items) {
  const enriched = [];
  for (const item of items.slice(0, ENRICH_LIMIT)) {
    try {
      const html = await fetchText(item.url);
      const description = extractMetaDescription(html);
      enriched.push({ ...item, snippet: item.snippet || description });
    } catch (error) {
      console.warn(`아이템 상세 가져오기 실패: ${item.url}`, error.message);
      enriched.push(item);
    }
  }
  if (items.length > ENRICH_LIMIT) {
    enriched.push(...items.slice(ENRICH_LIMIT));
  }
  return enriched;
}

async function collectItems() {
  const collected = [];
  for (const source of SOURCES) {
    try {
      logDebug('source:start', source.id, source.url);
      const raw = await fetchText(source.url);
      const items = source.parser(raw, source) || [];
      logDebug('source:parsed', source.id, items.length);
      collected.push(...items);
    } catch (error) {
      console.warn(`소스 처리 실패: ${source.name}`, error.message);
      logDebug('source:error', source.id, error.stack || error.message);
    }
  }
  return collected;
}

function filterDuplicates(items, seen) {
  const unique = [];
  const seenThisRun = new Set();
  for (const item of items) {
    const key = normalizeUrl(item.url);
    if (!key) continue;
    if (seen.items[key]) continue;
    if (seenThisRun.has(key)) continue;
    seenThisRun.add(key);
    unique.push({ ...item, url: key });
  }
  return unique;
}

function dedupeWithinRun(items) {
  const unique = [];
  const seenThisRun = new Set();
  for (const item of items) {
    const key = normalizeUrl(item.url);
    if (!key || seenThisRun.has(key)) continue;
    seenThisRun.add(key);
    unique.push({ ...item, url: key });
  }
  return unique;
}

function categorizeFallback(items) {
  return items.map((item) => ({
    ...item,
    category: 'news',
    summary_ko: item.snippet || `${item.title} 관련 업데이트입니다.`,
    summary_en: item.type === 'paper' ? 'Summary unavailable.' : '',
  }));
}

async function callGeminiAPI(prompt, apiKey) {
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  };

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    logDebug('gemini:fail', response.status, text.slice(0, 400));
    throw new Error(`Gemini API Error: ${response.status} ${text}`);
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((part) => part.text || '').join('').trim();
  logDebug('gemini:ok', `chars=${text.length}`);
  return text;
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (error) {
    console.warn('JSON 파싱 실패:', error.message);
    return null;
  }
}

function buildPrompt(items, dateString) {
  return `오늘 날짜(${dateString}) 기준으로 최신 VLM, sLLM, on-device AI 관련 논문/뉴스를 한국어로 요약해야 합니다.\n\n입력 데이터(JSON 배열)에는 title, url, sourceName, type, snippet가 포함됩니다.\n\n규칙:\n- 항목을 category: "vlm" | "sllm" | "ondevice" | "news" 중 하나로 분류하세요.\n- summary_ko: 2~3문장 요약.\n- papers(type=paper)에는 summary_en(영문 번역)도 제공하세요. news는 summary_en을 빈 문자열로 두세요.\n- 실제로 최신성과 중요도가 높은 항목 위주로 최대 12개 선택하세요.\n- 입력에 없는 내용은 추가하지 마세요.\n\n출력은 반드시 아래 JSON 형식만 반환하세요:\n{\n  "items": [\n    {\n      "title": "",\n      "url": "",\n      "source": "",\n      "type": "paper|news",\n      "category": "vlm|sllm|ondevice|news",\n      "summary_ko": "",\n      "summary_en": ""\n    }\n  ]\n}\n\n입력 데이터:\n${JSON.stringify(items, null, 2)}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmptyState() {
  return `
    <section class="section-block">
      <div class="section-header">
        <h2>오늘의 브리핑을 준비하지 못했습니다</h2>
        <p>소스 수집 또는 요약 과정에서 문제가 발생했습니다. 소스 상태 및 API 키를 확인해주세요.</p>
      </div>
    </section>
  `;
}

function renderCard(item) {
  const summaryEn = item.type === 'paper' && item.summary_en
    ? `<p class="card-translation"><span>English</span> ${escapeHtml(item.summary_en)}</p>`
    : '';

  return `
    <article class="card" data-item-url="${escapeHtml(item.url)}" data-source="${escapeHtml(item.source)}" data-item-type="${escapeHtml(item.type)}">
      <header>
        <h3>${escapeHtml(item.title)}</h3>
        <div class="card-meta">
          <span class="pill">${escapeHtml(item.type === 'paper' ? 'Paper' : 'News')}</span>
          <span class="source">${escapeHtml(item.source)}</span>
        </div>
      </header>
      <p class="card-summary">${escapeHtml(item.summary_ko)}</p>
      ${summaryEn}
      <a class="card-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">원문 보기</a>
    </article>
  `;
}

function renderSection(title, description, items) {
  if (!items.length) return '';
  const cards = items.map(renderCard).join(EOL);
  return `
    <section class="section-block">
      <div class="section-header">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
      <div class="card-grid">
        ${cards}
      </div>
    </section>
  `;
}

function groupByCategory(items) {
  const grouped = { vlm: [], sllm: [], ondevice: [], news: [] };
  for (const item of items) {
    const key = grouped[item.category] ? item.category : 'news';
    grouped[key].push(item);
  }
  return grouped;
}

function updateSeen(seen, items, dateString, lookup) {
  for (const item of items) {
    const key = normalizeUrl(item.url);
    if (!key) continue;
    const original = lookup.get(key) || {};
    if (!seen.items[key]) {
      seen.items[key] = {
        title: item.title,
        sourceId: original.sourceId,
        sourceName: original.sourceName || item.source,
        firstSeen: dateString,
        lastSeen: dateString,
      };
    } else {
      seen.items[key].lastSeen = dateString;
    }
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY가 설정되지 않았습니다.');
    process.exit(1);
  }

  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR);
  }

  const today = new Date();
  const defaultDate = today.toISOString().split('T')[0];
  const dateString = FORCE_DATE && /^\\d{4}-\\d{2}-\\d{2}$/.test(FORCE_DATE) ? FORCE_DATE : defaultDate;
  if (FORCE_DATE && dateString !== FORCE_DATE) {
    console.warn(`FORCE_DATE 형식이 올바르지 않아 ${defaultDate}로 진행합니다.`);
  }
  console.log(`생성 날짜: ${dateString}`);

  console.log('소스 수집 중...');
  const rawItems = await collectItems();
  console.log(`수집된 원본 항목: ${rawItems.length}`);
  const seen = loadSeen();
  logDebug('seen:loaded', Object.keys(seen.items || {}).length);
  let uniqueItems = filterDuplicates(rawItems, seen);
  console.log(`중복 제거 후 항목: ${uniqueItems.length}`);
  if (uniqueItems.length < MIN_ITEMS_TOTAL) {
    console.warn('중복 제거 후 항목이 부족하여 기존 항목도 포함합니다.');
    uniqueItems = dedupeWithinRun(rawItems);
  }
  const enrichedItems = await enrichItems(uniqueItems);
  logDebug('enrich:done', enrichedItems.length);
  const trimmedItems = enrichedItems.slice(0, MAX_ITEMS_TOTAL);
  console.log(`요약 대상 항목: ${trimmedItems.length}`);
  const sourceLookup = new Map(trimmedItems.map((item) => [normalizeUrl(item.url), item]));

  console.log('Gemini 요약 생성 중...');
  let summarizedItems = [];
  try {
    const prompt = buildPrompt(trimmedItems, dateString);
    logDebug('gemini:prompt_chars', prompt.length);
    const responseText = await callGeminiAPI(prompt, apiKey);
    logDebug('gemini:raw', responseText.slice(0, 500));
    const parsed = extractJson(responseText);
    logDebug('gemini:parsed', parsed ? 'ok' : 'null');
    summarizedItems = parsed?.items?.length ? parsed.items : [];
    console.log(`Gemini 반환 항목: ${summarizedItems.length}`);
  } catch (error) {
    console.error('Gemini API 호출 실패:', error);
  }

  if (!summarizedItems.length) {
    console.warn('Gemini 요약이 비어 있어 fallback 요약을 사용합니다.');
    summarizedItems = categorizeFallback(trimmedItems).map((item) => ({
      title: item.title,
      url: item.url,
      source: item.sourceName,
      type: item.type,
      category: item.category,
      summary_ko: item.summary_ko,
      summary_en: item.summary_en,
      sourceId: item.sourceId,
    }));
  }

  const normalizedItems = summarizedItems.map((item) => ({
    ...item,
    source: item.source || item.sourceName || 'Unknown',
  }));
  logDebug('normalized:count', normalizedItems.length);

  const grouped = groupByCategory(normalizedItems);

  const contentHtml = normalizedItems.length ? [
    renderSection('VLM 업데이트', '멀티모달 비전-언어 모델의 최신 논문과 리더보드 변화', grouped.vlm),
    renderSection('sLLM 트렌드', '경량화·효율화를 위한 스몰 LLM 연구', grouped.sllm),
    renderSection('On-Device AI', '디바이스 내 추론 및 엣지 최적화 동향', grouped.ondevice),
    renderSection('AI 뉴스 & 리서치', '기업/연구기관의 주요 발표와 블로그 업데이트', grouped.news),
  ].join(EOL) : buildEmptyState();

  const sourcesHtml = SOURCES.map((source) => {
    return `<li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.name)}</a></li>`;
  }).join(EOL);

  const template = fs.readFileSync('template.html', 'utf-8');
  const newPageContent = template
    .replace(/{{DATE}}/g, dateString)
    .replace('{{CONTENT}}', contentHtml)
    .replace('{{SOURCES}}', sourcesHtml)
    .replace('{{TOTAL_COUNT}}', String(normalizedItems.length));

  fs.writeFileSync(`${ARCHIVE_DIR}/${dateString}.html`, newPageContent);
  console.log(`${dateString}.html 파일 생성 완료.`);

  updateSeen(seen, normalizedItems, dateString, sourceLookup);
  pruneSeen(seen);
  saveSeen(seen);
  logDebug('seen:saved', Object.keys(seen.items || {}).length);

  console.log('index.html 파일을 업데이트합니다.');
  const posts = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.html')).sort().reverse();
  const links = posts.map(post => {
    const date = post.replace('.html', '');
    return `<li><a href="archives/${date}.html">${date} AI 트렌드</a></li>`;
  }).join(EOL);

  let indexContent = fs.readFileSync('index.html', 'utf-8');
  indexContent = indexContent.replace(/<!-- LATEST_LINKS -->[\s\S]*?<\/ul>/, `<!-- LATEST_LINKS -->${EOL}${links}${EOL}</ul>`);
  fs.writeFileSync('index.html', indexContent);
  console.log('index.html 파일 업데이트 완료.');
}

main();
