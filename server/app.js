import path from 'node:path';
import express from 'express';
import compression from 'compression';
import morgan from 'morgan';
import config from '../config.js';
import apiRoutes from './routes/api.js';
import pageRoutes from './routes/pages.js';
import authRoutes from './routes/auth.js';
import manageRoutes from './routes/manage.js';
import gitRoutes from './routes/git.js';
import uploadRoutes from './routes/upload.js';
import * as auth from './lib/auth.js';
import * as registry from './lib/repos.js';
import { viewHelpers } from './lib/view-helpers.js';
import { statusForGitError, NotFoundError, ValidationError } from './lib/validate.js';
import { escapeHtml } from './lib/render.js';

export function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'views'));
  app.set('x-powered-by', false);
  app.set('query parser', 'simple');
  if (config.auth.trustProxy) app.set('trust proxy', 1);

  app.use(compression());
  app.use(morgan(config.logFormat, {
    skip: (req) => req.path === '/api/status',
  }));

  // Bodies are only needed for the login / register / request forms, so the
  // limit is deliberately small. `res.cookie` / `res.clearCookie` come from
  // Express itself.
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  // Conservative security headers. The site renders repository content, so we
  // lock down framing and sniffing.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: https:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "font-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'self'",
      ].join('; '),
    );
    next();
  });

  // Static assets come first: they need neither a session nor a CSRF token, so
  // serving them ahead of auth avoids a cookie lookup per stylesheet.
  app.use(express.static(path.join(config.root, 'public'), {
    maxAge: '1h',
    etag: true,
  }));

  // Order matters: identify the user first, let the unauthenticated routes
  // (sign in / register) through, gate everything else, then route.
  app.use(auth.attachUser);
  app.use((_req, res, next) => {
    res.locals.user = auth.publicUser(res.req.user);
    res.locals.csrf = res.req.session ? res.req.session.csrf : '';
    res.locals.site = config.site;
    res.locals.h = viewHelpers;
    next();
  });

  app.use(authRoutes);

  app.use(authRoutes);

  // The git endpoints sit before the CSRF gate and authenticate themselves with
  // HTTP Basic: git cannot carry a token, and it presents a credential on every
  // request. Their paths (`/<owner>/<name>.git/...`) would also be swallowed by
  // the page router's `/:owner/:name` pattern if they came later.
  app.use(gitRoutes);

  app.use(auth.requireAuth);
  // Every route past this point that accepts a POST is a form handler, so the
  // CSRF token is enforced globally rather than per route.
  app.use(auth.requireCsrf);

  // /api next: it has its own catch-all for unknown endpoints.
  app.use('/api', apiRoutes);
  // Then the management routes. These must precede pageRoutes, whose
  // "/:owner/:name" pattern would otherwise swallow "/new" and "/admin".
  app.use(manageRoutes);
  // Writing actions live under the repository they apply to. The mount only
  // strips the prefix; unmatched paths fall through to the page router.
  app.use('/:owner/:name', uploadRoutes);
  app.use(pageRoutes);

  // 404 handler
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'not found', path: req.path });
    }
    res.status(404).render('error', {
      title: 'Not found',
      status: 404,
      message: `Nothing lives at ${req.path}`,
      detail: 'The repository, branch or file you asked for does not exist.',
    });
  });

  // Central error handler: logs the real cause, shows something safe.
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, _next) => {
    const status = error.status || statusForGitError(error);
    const isApi = req.path.startsWith('/api/');

    if (status >= 500) {
      console.error(`[error] ${req.method} ${req.originalUrl}`, error);
    }

    if (isApi) {
      return res.status(status).json({
        error: status >= 500 ? 'internal error' : error.message,
        status,
      });
    }

    res.status(status).render('error', {
      title: status === 404 ? 'Not found' : 'Something went wrong',
      status,
      message: status >= 500 ? 'The server hit an unexpected error.' : error.message,
      detail: status >= 500 ? String(error.message).slice(0, 400) : '',
      stack: config.showStacks ? String(error.stack || '') : '',
    });
  });

  return app;
}

/** Scan the configured roots before the server accepts connections. */
export async function bootstrap({ silent = false } = {}) {
  const started = Date.now();
  const listing = await registry.scan();
  if (!silent) {
    const roots = config.repoRoots.map((root) => root.replace(config.root, '.')).join(', ');
    console.log(
      `[scan] ${listing.total} repositor${listing.total === 1 ? 'y' : 'ies'} in ${Date.now() - started}ms from ${roots}`,
    );
    for (const entry of listing.all) {
      console.log(`       · ${entry.id}`);
    }
  }
  return listing;
}

export { escapeHtml, NotFoundError, ValidationError };
