import express from 'express';
import config from '../../config.js';
import * as auth from '../lib/auth.js';
import { ValidationError } from '../lib/validate.js';

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Only ever bounce back to a path on this site. */
function safeNext(value) {
  const target = String(value || '/');
  if (!target.startsWith('/') || target.startsWith('//')) return '/';
  return target;
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(302, '/');
  res.render('login', { title: 'Sign in', error: null, values: {}, next: safeNext(req.query.next) });
});

router.post('/login', auth.requireCsrf, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const next = safeNext(req.body.next);

  const throttle = auth.loginThrottle(req, username);
  if (!throttle.allowed) {
    return res.status(429).render('login', {
      title: 'Sign in',
      error: `Too many attempts. Try again in ${throttle.retryInMinutes} minute(s).`,
      values: { username },
      next,
    });
  }

  const user = await auth.findUser(username);
  // Always run a hash comparison so a missing user and a wrong password take a
  // similar amount of time.
  const ok = user
    ? auth.verifyPassword(password, user.password)
    : auth.verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');

  if (!user || !ok) {
    return res.status(401).render('login', {
      title: 'Sign in',
      error: 'Incorrect username or password.',
      values: { username },
      next,
    });
  }

  auth.clearLoginThrottle(req, username);
  const csrf = auth.newCsrfToken();
  auth.setSessionCookie(res, {
    sub: user.username,
    role: user.role,
    csrf,
    exp: Date.now() + 12 * 60 * 60 * 1000,
  });

  res.redirect(302, next !== '/' ? next : (user.role === 'admin' ? '/admin' : '/'));
}));

router.get('/register', wrap(async (req, res) => {
  if (req.user) return res.redirect(302, '/');
  if (!config.auth.allowSignup) {
    return res.status(403).render('error', {
      title: 'Registration closed',
      status: 403,
      message: 'Self-registration is disabled on this server. Ask an administrator for an account.',
      detail: '',
    });
  }
  const users = await auth.allUsers({ fresh: true });
  res.render('register', {
    title: 'Create an account',
    error: null,
    values: {},
    isFirstUser: users.length === 0,
  });
}));

router.post('/register', auth.requireCsrf, wrap(async (req, res) => {
  if (!config.auth.allowSignup) {
    return res.status(403).render('error', {
      title: 'Registration closed',
      status: 403,
      message: 'Self-registration is disabled on this server.',
      detail: '',
    });
  }

  try {
    const existing = await auth.allUsers({ fresh: true });
    const wasFirst = existing.length === 0;

    const user = await auth.createUser({
      username: req.body.username,
      password: req.body.password,
      displayName: req.body.displayName,
    });

    const csrf = auth.newCsrfToken();
    auth.setSessionCookie(res, {
      sub: user.username,
      role: user.role,
      csrf,
      exp: Date.now() + 12 * 60 * 60 * 1000,
    });

    if (wasFirst) {
      req.session = { sub: user.username, csrf };
      return res.redirect(302, '/admin?welcome=1');
    }
    return res.redirect(302, '/');
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).render('register', {
        title: 'Create an account',
        error: error.message,
        values: { username: req.body.username, displayName: req.body.displayName },
        isFirstUser: false,
      });
    }
    throw error;
  }
}));

router.post('/logout', auth.requireCsrf, (req, res) => {
  auth.clearSessionCookie(res);
  res.redirect(302, '/login');
});

export default router;
export { safeNext };
