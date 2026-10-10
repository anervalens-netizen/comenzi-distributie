export function validatePublicDsn(value) {
  if (typeof value !== 'string' || !value || /\s/.test(value)) throw new Error('A valid public error-reporting DSN is required');
  let url; try { url=new URL(value); } catch { throw new Error('Invalid error-reporting DSN URL'); }
  const labels=url.hostname.split('.');
  const loopback=url.hostname==='localhost' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (!(url.protocol==='https:' || (url.protocol==='http:' && loopback)) || !/^\w+$/.test(url.username)
      || (url.password && !/^\w+$/.test(url.password))
      || !labels.every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))
      || (url.port && (+url.port<1 || +url.port>65535))
      || !/^\/(?:[A-Za-z0-9._~-]+\/)*\d+$/.test(url.pathname) || url.search || url.hash)
    throw new Error('Invalid error-reporting DSN components');
  return url;
}
