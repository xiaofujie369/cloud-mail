import axios from 'axios';

const smtpHttp = axios.create({
  baseURL: import.meta.env.VITE_SMTP_API_URL || '/smtp-api',
  timeout: 30000
});

function auth(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`
    }
  };
}

export function smtpStats(token, days = 14) {
  return smtpHttp.get('/admin/stats', {
    ...auth(token),
    params: { days }
  }).then(res => res.data);
}

export function smtpMessages(token, params = {}) {
  return smtpHttp.get('/admin/messages', {
    ...auth(token),
    params
  }).then(res => res.data);
}

export function smtpSend(token, data) {
  return smtpHttp.post('/send', data, auth(token)).then(res => res.data);
}
