// 에이전트가 쓰는 도구 2개: find_spots(관광지 목록), get_weather(Open-Meteo 날씨)
const { spots } = require("../jeju_spots.json");

const AREAS = ["동쪽", "서쪽", "서귀포", "제주시"];
const MAX_RESULTS = 8;
const DAYS = ["오늘", "내일", "모레"]; // 예보 배열의 0, 1, 2번째 날

// 날씨 조회용 지역 대표 좌표(대략값)
const WEATHER_POINTS = {
  동쪽: [33.458, 126.93],
  서쪽: [33.33, 126.3],
  서귀포: [33.25, 126.56],
  제주시: [33.5, 126.53],
};

// WMO 날씨 코드 → 한글
const WEATHER_TEXT = (code) => {
  if (code === 0) return "맑음";
  if (code <= 3) return "구름 조금~흐림";
  if (code <= 48) return "안개";
  if (code <= 57) return "이슬비";
  if (code <= 67) return "비";
  if (code <= 77) return "눈";
  if (code <= 82) return "소나기";
  if (code <= 86) return "눈 소나기";
  return "뇌우";
};

// 모델에 넘기는 도구 설명
const toolDefinitions = [
  {
    name: "find_spots",
    description:
      "제주도 관광지 목록(jeju_spots.json)에서 지역과 실내/야외 조건에 맞는 장소를 최대 8곳 찾아 " +
      "이름·지역·실내 여부·설명을 돌려준다. " +
      "목록 밖 장소는 없다: 결과에 없는 장소는 추천하거나 지어내지 말고, 결과가 비면 조건에 맞는 장소가 목록에 없다고 답한다. " +
      "운영시간·요금·휴무 정보는 담겨 있지 않다.",
    input_schema: {
      type: "object",
      properties: {
        area: {
          type: "string",
          enum: AREAS,
          description: "찾을 지역. 동쪽 · 서쪽 · 서귀포 · 제주시 중 하나.",
        },
        indoor: {
          type: "boolean",
          description: "true면 실내만, false면 야외만. 생략하면 둘 다.",
        },
      },
      required: ["area"],
    },
  },
  {
    name: "get_weather",
    description:
      "제주 지역의 현재 날씨와 오늘부터 3일간 예보(Open-Meteo)를 돌려준다. " +
      "기온(°C), 날씨, 강수확률(%), 풍속(km/h)이 들어 있다. " +
      "사용자가 말한 날(오늘·내일·모레)을 day로 지정하면 그날의 예보를 selected에 담아 준다. " +
      "비가 오거나 강수확률이 높으면 실내, 맑으면 야외를 추천하는 판단에 쓴다.",
    input_schema: {
      type: "object",
      properties: {
        area: {
          type: "string",
          enum: AREAS,
          description: "날씨를 볼 지역. 동쪽 · 서쪽 · 서귀포 · 제주시 중 하나.",
        },
        day: {
          type: "string",
          enum: DAYS,
          description: "어느 날의 날씨를 볼지. 오늘 · 내일 · 모레 중 하나. 생략하면 오늘.",
        },
      },
      required: ["area"],
    },
  },
];

// area는 '동쪽(성산)'처럼 읍면이 괄호로 붙을 수 있어 앞부분으로 비교한다.
function findSpots({ area, indoor } = {}) {
  if (!AREAS.includes(area)) {
    return { error: `area는 ${AREAS.join(" · ")} 중 하나여야 합니다.` };
  }
  const found = spots.filter(
    (s) =>
      s.area.split("(")[0] === area &&
      (typeof indoor !== "boolean" || s.indoor === indoor)
  );
  return {
    total: found.length,
    spots: found.slice(0, MAX_RESULTS).map((s) => ({
      name: s.name,
      area: s.area,
      indoor: s.indoor,
      description: s.type,
    })),
  };
}

async function getWeather({ area, day = "오늘" } = {}) {
  if (!AREAS.includes(area)) {
    return { error: `area는 ${AREAS.join(" · ")} 중 하나여야 합니다.` };
  }
  const dayIndex = Math.max(0, DAYS.indexOf(day)); // 모르는 값이면 오늘
  const [lat, lng] = WEATHER_POINTS[area];
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lng}` +
    "&current=temperature_2m,precipitation,weather_code,wind_speed_10m" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max" +
    "&timezone=Asia%2FSeoul&forecast_days=3";
  const res = await fetch(url);
  if (!res.ok) return { error: `날씨 조회 실패 (HTTP ${res.status})` };
  const d = await res.json();
  const forecast = d.daily.time.map((date, i) => ({
    day: DAYS[i],
    date,
    weather: WEATHER_TEXT(d.daily.weather_code[i]),
    min: d.daily.temperature_2m_min[i],
    max: d.daily.temperature_2m_max[i],
    rain_probability: d.daily.precipitation_probability_max[i],
    wind_kmh: d.daily.wind_speed_10m_max[i],
  }));
  return {
    area,
    day: DAYS[dayIndex],
    dayIndex,
    selected: forecast[dayIndex], // 사용자가 물은 날의 예보
    now: {
      temperature: d.current.temperature_2m,
      weather: WEATHER_TEXT(d.current.weather_code),
      precipitation_mm: d.current.precipitation,
      wind_kmh: d.current.wind_speed_10m,
    },
    forecast,
  };
}

const handlers = { find_spots: findSpots, get_weather: getWeather };

// 도구 이름과 입력으로 실행 (비동기). 오류는 예외 대신 {error}로 돌려줘 에이전트가 읽게 한다.
async function runTool(name, input) {
  const handler = handlers[name];
  if (!handler) return { error: `알 수 없는 도구: ${name}` };
  try {
    return await handler(input);
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

module.exports = { toolDefinitions, findSpots, getWeather, runTool };
