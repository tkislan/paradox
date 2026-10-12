export const html = (body, status = 200, headers = {}) => ({ status, headers: { 'Content-Type': 'text/html', ...headers }, body });
