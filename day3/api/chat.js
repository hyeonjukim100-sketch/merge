// POST /api/chat  { message: "..." }  →  { answer, steps }
// Gemini가 find_spots · get_weather 를 스스로 골라 부르고, 결과를 바탕으로 추천한다.
const { toolDefinitions, runTool } = require("../lib/tools");

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_TURNS = 5; // 도구 호출 왕복 상한
const MAX_INPUT = 300;

const SYSTEM = `너는 제주도 여행 추천 도우미다.
- 사용자의 요청에서 지역(동쪽·서쪽·서귀포·제주시)과 실내/야외 선호를 파악한다. 지역이 없으면 제주시 기준으로 하고 그 사실을 말한다.
- 사용자가 말한 날(오늘·내일·모레)을 get_weather 의 day 로 지정한다. 말이 없으면 오늘이다. 추천은 그날의 날씨(selected)를 기준으로 하고, LEAD 문장에도 그날을 밝힌다.
- 추천 전에 get_weather 로 날씨를 확인하고, find_spots 로 후보를 찾는다. 두 도구는 서로 독립적이라 한 번에 같이 불러도 된다.
- 비가 오거나 강수확률이 높으면 실내 위주로, 맑으면 야외 위주로 추천한다. 사용자가 실내/야외를 정했으면 그 선호를 우선한다.
- 추천은 find_spots 결과에 있는 장소만 쓴다. 목록 밖 장소를 지어내지 않는다.
- 3곳을 고른다.

최종 답변은 마크다운 기호(**, #, -, 번호 목록 등)를 절대 쓰지 말고, 아래 형식의 일반 텍스트로만 쓴다. 다른 문장은 덧붙이지 않는다.
LEAD: 날씨를 반영해 어떤 명소를 추천하는지 알려 주는 짧은 한 문장 (예: 오늘은 맑아서 탁 트인 야외 명소를 골라봤어요)
PICK: find_spots 결과에 있는 장소 이름 그대로 | 이 장소를 소개하는 한 문장
PICK: ...
PICK: ...`;

// 모델이 붙였을 수 있는 마크다운 기호 제거
const clean = (s) => String(s).replace(/\*+|`+/g, "").replace(/^#+\s*/, "").trim();

// "LEAD:/PICK:" 형식의 답을 읽는다. 장소 이름은 find_spots 결과에 있는 것만 인정한다.
function parseAnswer(text, steps) {
  const known = new Map(
    steps.filter((s) => s.tool === "find_spots").flatMap((s) => (s.output.spots ?? []).map((p) => [p.name, p.description]))
  );
  let lead = "";
  const picks = [];
  for (const raw of text.split("\n")) {
    const line = clean(raw);
    if (line.startsWith("LEAD:")) lead = line.slice(5).trim();
    else if (line.startsWith("PICK:")) {
      const [name, ...rest] = line.slice(5).split("|");
      const n = name.trim();
      if (known.has(n)) picks.push({ name: n, desc: rest.join("|").trim(), type: known.get(n) });
    }
  }
  const weather = steps.find((s) => s.tool === "get_weather" && !s.output.error)?.output ?? null;
  return { weather, lead, picks, answer: picks.length ? "" : clean(text) };
}

// lib/tools.js 의 정의(input_schema)를 Gemini 형식(parameters)으로 바꾼다
const functionDeclarations = toolDefinitions.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.input_schema,
}));

async function callGemini(contents) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents,
        tools: [{ functionDeclarations }],
        generationConfig: { maxOutputTokens: 1024 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 지원합니다." });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경변수가 없습니다." });
  }

  const message = String(req.body?.message ?? "").trim().slice(0, MAX_INPUT);
  if (!message) return res.status(400).json({ error: "message가 비어 있습니다." });

  const contents = [{ role: "user", parts: [{ text: message }] }];
  const steps = [];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const reply = await callGemini(contents);
      const content = reply.candidates?.[0]?.content;
      if (!content?.parts?.length) {
        const why = reply.candidates?.[0]?.finishReason || reply.promptFeedback?.blockReason || "알 수 없음";
        return res.status(200).json({ answer: `모델이 답을 만들지 못했습니다. (${why})`, picks: [] });
      }
      contents.push(content); // 모델 응답은 그대로 되돌려 보낸다

      const calls = content.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      if (!calls.length) {
        const answer = content.parts.map((p) => p.text ?? "").join("");
        return res.status(200).json(parseAnswer(answer, steps));
      }

      // 같은 턴의 도구 호출은 동시에 실행
      const results = await Promise.all(
        calls.map(async (c) => {
          const output = await runTool(c.name, c.args ?? {});
          steps.push({ tool: c.name, input: c.args ?? {}, output });
          return { functionResponse: { name: c.name, response: output } };
        })
      );
      contents.push({ role: "user", parts: results });
    }
    res.status(200).json({ answer: "도구 호출이 너무 길어져 중단했습니다. 질문을 더 간단히 해 주세요.", picks: [] });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
