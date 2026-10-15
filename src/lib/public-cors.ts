const PUBLIC_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Cache-Bypass",
  "Access-Control-Max-Age": "86400",
};

export function withPublicCors<T extends Response>(response: T): T {
  for (const [name, value] of Object.entries(PUBLIC_CORS_HEADERS)) {
    response.headers.set(name, value);
  }

  return response;
}

export function publicOptionsResponse(methods: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...PUBLIC_CORS_HEADERS,
      "Access-Control-Allow-Methods": methods,
      Allow: methods,
    },
  });
}