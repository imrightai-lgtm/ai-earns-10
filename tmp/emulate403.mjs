// Эмуляция запуска с VPS, которому провайдер отдаёт 403: проверяем, что BLOCKED больше
// не считается отказом рельсы и не помечает страницу как ONLY-DEAD-RAIL.
const real = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/.well-known/lnurlp/')) {
    return new Response('access denied', { status: 403 });
  }
  return real(url, opts);
};
await import('../tools/check-payrail.mjs');
