// Vercel 서버리스 함수: 브라우저 대신 서버에서 Pixabay를 호출해 API 키를 숨깁니다.
// 키는 Vercel 환경변수 PIXABAY_API_KEY 에서 읽습니다.
const PER_PAGE = 10;

module.exports = async (req, res) => {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) {
    return res.status(500).json({ error: '서버에 PIXABAY_API_KEY 환경변수가 설정되지 않았습니다.' });
  }

  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.status(400).json({ error: '검색어를 입력해 주세요.' });
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 50);

  const url = 'https://pixabay.com/api/?' + new URLSearchParams({
    key, q, page, per_page: PER_PAGE, image_type: 'photo', lang: 'ko', safesearch: 'true'
  });

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      const msg = upstream.status === 429 ? '요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.' : 'Pixabay 오류 (' + upstream.status + ')';
      return res.status(upstream.status === 429 ? 429 : 502).json({ error: msg });
    }
    const data = await upstream.json();
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).json({
      totalHits: data.totalHits,
      hits: data.hits.map(h => ({ webformatURL: h.webformatURL, tags: h.tags, user: h.user, pageURL: h.pageURL }))
    });
  } catch (e) {
    return res.status(502).json({ error: 'Pixabay에 연결하지 못했습니다.' });
  }
};
