import { requireThat } from '../identity.mjs';

export function sharedWorkerReader(credential, request = fetch) {
  requireThat(credential?.isSecret === true && typeof credential.value === 'string' &&
    /^[A-Za-z0-9._~+\/=-]{20,4096}$/.test(credential.value),
  'SHARED_WORKER_READ_CREDENTIAL_UNAVAILABLE');
  const token = credential.value;
  return { async get(path) {
    const route = path.split('?')[0];
    requireThat(/^\/repos\/[A-Za-z0-9_./-]+$/.test(route) && !/[\r\n#\\]/.test(path),
      'SHARED_WORKER_PROVIDER_PATH_INVALID');
    const unavailable = status => Object.assign(
      new Error('SHARED_WORKER_PROVIDER_UNAVAILABLE'),
      { code: 'SHARED_WORKER_PROVIDER_UNAVAILABLE', route, status },
    );
    try {
      const response = await request(`https://api.github.com${path}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) throw unavailable(response.status);
      return await response.json();
    } catch (error) {
      if (error.code === 'SHARED_WORKER_PROVIDER_UNAVAILABLE') throw error;
      throw unavailable(null);
    }
  } };
}

export function sharedWorkerDiagnostic(error) {
  const code = /^[A-Z][A-Z0-9_]{1,90}$/.test(error?.code ?? '')
    ? error.code : 'SHARED_WORKER_ADMISSION_FAILED';
  if (code !== 'SHARED_WORKER_PROVIDER_UNAVAILABLE') return code;
  const status = Number.isInteger(error.status) ? `HTTP ${error.status}` : 'read failed';
  return `${code} GET ${error.route} ${status}`;
}
