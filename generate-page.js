import fetch from 'node-fetch';
import fs from 'fs';
import { EOL } from 'os';

// Gemini API 호출 함수
async function callGeminiAPI(prompt, apiKey) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
    };

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            throw new Error(`API Error: ${response.statusText}`);
        }
        const data = await response.json();
        return data.candidates[0].content.parts[0].text;
    } catch (error) {
        console.error('Gemini API 호출 실패:', error);
        return "콘텐츠 생성에 실패했습니다.";
    }
}

// 응답 텍스트를 HTML 형식으로 변환
function formatContent(rawText) {
    return rawText
        .replace(/\*\*(.*?)\*\*/g, '<strong class="text-indigo-600">$1</strong>')
        .replace(/\n/g, '<br>')
        .replace(/\[링크\]\((.*?)\)/g, '<a href="$1" target="_blank" class="text-blue-500 hover:underline break-all">[관련 링크]</a>');
}

// 메인 실행 함수
async function main() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("GEMINI_API_KEY가 설정되지 않았습니다.");
        process.exit(1);
    }
    
    // 프롬프트 정의
    const trendPrompt = `오늘 날짜를 기준으로 가장 중요한 AI 기술 동향을 뉴스 기사나 블로그를 근거로 하나 알려줘. 아래 형식에 맞춰서 답변해줘. \n\n**[주요 동향 제목]**\n\n[설명 3~4문장]\n\n[링크]([실제 URL])`;
    const paperPrompt = `최근 2주 이내 발표된 AI 논문 중 가장 흥미로운 것 하나를 선정해서, 일반인이 이해하기 쉽게 설명해줘. 아래 형식에 맞춰서 답변해줘. \n\n**[논문 제목]**\n\n[핵심 내용 요약 4~5문장]\n\n[링크]([arXiv 등 논문 URL])`;

    console.log("Gemini API에서 콘텐츠를 가져오는 중...");
    const [trendResponse, paperResponse] = await Promise.all([
        callGeminiAPI(trendPrompt, apiKey),
        callGeminiAPI(paperPrompt, apiKey)
    ]);

    const trendContent = formatContent(trendResponse);
    const paperContent = formatContent(paperResponse);

    console.log("콘텐츠 생성 완료. HTML 파일을 만듭니다.");
    const today = new Date();
    const dateString = today.toISOString().split('T')[0]; // YYYY-MM-DD
    
    // 새 페이지 생성
    const template = fs.readFileSync('template.html', 'utf-8');
    const newPageContent = template
        .replace(/{{DATE}}/g, dateString)
        .replace('{{TREND_CONTENT}}', trendContent)
        .replace('{{PAPER_CONTENT}}', paperContent);

    fs.writeFileSync(`archives/${dateString}.html`, newPageContent);
    console.log(`${dateString}.html 파일 생성 완료.`);

    // 인덱스 페이지 업데이트
    console.log("index.html 파일을 업데이트합니다.");
    const newLink = `<li><a href="archives/${dateString}.html" class="text-lg text-blue-600 hover:text-blue-800 transition-colors">${dateString} AI 트렌드</a></li>`;
    
    let indexContent = fs.readFileSync('index.html', 'utf-8');
    const posts = fs.readdirSync('archives').filter(f => f.endsWith('.html')).sort().reverse();
    
    const links = posts.map(post => {
        const date = post.replace('.html', '');
        return `<li><a href="archives/${date}.html" class="text-lg text-blue-600 hover:text-blue-800 transition-colors">${date} AI 트렌드</a></li>`;
    }).join(EOL);

    indexContent = indexContent.replace(/<!-- LATEST_LINKS -->[\s\S]*?<\/ul>/, `<!-- LATEST_LINKS -->${EOL}${links}${EOL}</ul>`);
    fs.writeFileSync('index.html', indexContent);
    console.log("index.html 파일 업데이트 완료.");
}

// `archives` 디렉토리가 없으면 생성
if (!fs.existsSync('archives')){
    fs.mkdirSync('archives');
}

main();