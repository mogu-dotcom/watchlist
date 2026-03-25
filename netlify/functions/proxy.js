// Netlify Serverless Function — Yahoo Finance CORS Proxy
// quoteSummary (earningsTrend 등) 요청 시 crumb를 서버 사이드에서 자동 획득·캐시합니다.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── 모듈 레벨 crumb 캐시 (Warm Lambda 인스턴스 간 재사용) ──────────────────
let _crumb = null;
let _cookies = '';
let _crumbExpiry = 0;

async function ensureCrumb() {
  if (_crumb && Date.now() < _crumbExpiry) return { crumb: _crumb, cookies: _cookies };

  try {
    // 1단계: Yahoo Finance 홈 접속 → 세션 쿠키 획득
    const homeRes = await fetch('https://finance.yahoo.com/', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
    });

    // Node 18+ getSetCookie() 배열 우선, 없으면 단일 헤더 파싱
    let cookieStr = '';
    if (typeof homeRes.headers.getSetCookie === 'function') {
      cookieStr = homeRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    } else {
      const raw = homeRes.headers.get('set-cookie') || '';
      cookieStr = raw.split(/,(?=[^ ])/).map(c => c.split(';')[0].trim()).join('; ');
    }

    // 2단계: crumb 획득
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': UA,
        'Cookie': cookieStr,
        'Referer': 'https://finance.yahoo.com/',
        'Accept': '*/*',
      },
    });
    const crumb = await crumbRes.text();

    // 유효한 crumb의지 확인 (짧은 문자열, JSON/HTML 아님)
    if (crumb && crumb.length < 30 && !crumb.startsWith('{') && !crumb.startsWith('<')) {
      _crumb = crumb.trim();
      _cookies = cookieStr;
      _crumbExpiry = Date.now() + 50 * 60 * 1000; // 50분 캐시
    }
  } catch (_) { /* 실패 시 기존 캐시 그대로 사용 */ }

  return { crumb: _crumb, cookies: _cookies };
}

// ── 메인 핸들러 ────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const targetUrl = event.queryStringParameters?.url;

  if (!targetUrl) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'url 파라미터가 필요합니다.' }) };
  }

  // Yahoo Finance 도메인만 허용 (보안)
  if (
    !targetUrl.includes('finance.yahoo.com') &&
    !targetUrl.includes('query1.finance.yahoo.com') &&
    !targetUrl.includes('query2.finance.yahoo.com')
  ) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: '허용되지 않는 도메인입니다.' }) };
  }

  try {
    let fetchUrl = targetUrl;
    const fetchHeaders = {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com/',
      'Origin': 'https://finance.yahoo.com',
    };

    // quoteSummary 요청 → crumb 자동 추가
    if (targetUrl.includes('quoteSummary')) {
      const { crumb, cookies } = await ensureCrumb();
      if (crumb) {
        const sep = fetchUrl.includes('?') ? '&' : '?';
        fetchUrl = `${fetchUrl}${sep}crumb=${encodeURIComponent(crumb)}`;
        if (cookies) fetchHeaders['Cookie'] = cookies;
      }
    }

    const response = await fetch(fetchUrl, { headers: fetchHeaders });
    const body = await response.text();

    // crumb 만료(401/Invalid Crumb) 시 캐시 초기화 후 1회 재시도
    if (response.status === 401 || (body.includes('Invalid Crumb') && targetUrl.includes('quoteSummary'))) {
      _crumb = null; _crumbExpiry = 0;
      const { crumb: newCrumb, cookies: newCookies } = await ensureCrumb();
      if (newCrumb) {
        const sep = targetUrl.includes('?') ? '&' : '?';
        const retryUrl = `${targetUrl}${sep}crumb=${encodeURIComponent(newCrumb)}`;
        const retryRes = await fetch(retryUrl, { headers: { ...fetchHeaders, Cookie: newCookies } });
        const retryBody = await retryRes.text();
        return {
          statusCode: retryRes.status,
          headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
          body: retryBody,
        };
      }
    }

    return {
      statusCode: response.status,
      headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
      body,
    };
  } catch (error) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }
};
