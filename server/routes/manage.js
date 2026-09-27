import express from 'express';
import * as auth from '../lib/auth.js';
import * as requests from '../lib/requests.js';
import * as provision from '../lib/provision.js';
import { ValidationError, NotFoundError } from '../lib/validate.js';

const router = express.Router({ mergeParams: true });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(auth.requireAuth);

/* ------------------------------------------------------- request a repo */

router.get('/new', wrap(async (req, res) => {
  const mine = await requests.list({ requestedBy: req.user.username });
  res.render('new', {
    title: 'New repository',
    error: null,
    values: {},
    templates: requests.templates,
    requests: mine,
    submitted: req.query.submitted || '',
    targetRoot: provision.targetRoot(),
  });
}));

router.post('/new', wrap(async (req, res) => {
  try {
    const record = await requests.submit({
      name: req.body.name,
      description: req.body.description,
      template: req.body.template,
      requestedBy: auth.publicUser(req.user),
    });
    return res.redirect(302, `/new?submitted=${encodeURIComponent(record.id)}`);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    const mine = await requests.list({ requestedBy: req.user.username });
    return res.status(400).render('new', {
      title: 'New repository',
      error: error.message,
      values: { name: req.body.name, description: req.body.description, template: req.body.template },
      templates: requests.templates,
      requests: mine,
      submitted: '',
      targetRoot: provision.targetRoot(),
    });
  }
}));

/* ---------------------------------------------------------------- admin */

router.get('/admin', auth.requireAdmin, wrap(async (req, res) => {
  const [pending, decided, users] = await Promise.all([
    requests.list({ status: 'pending' }),
    requests.list({}),
    auth.allUsers({ fresh: true }),
  ]);

  res.render('admin', {
    title: 'Administration',
    welcome: req.query.welcome === '1',
    pending: pending.filter((entry) => entry.status === 'pending'),
    decided: decided.filter((entry) => entry.status !== 'pending'),
    users: users.map((user) => auth.publicUser(user)),
    targetRoot: provision.targetRoot(),
  });
}));

router.post('/admin/requests/:id/:decision', auth.requireAdmin, wrap(async (req, res) => {
  const { id, decision } = req.params;
  if (!['approve', 'reject'].includes(decision)) {
    throw new ValidationError('a decision must be approve or reject');
  }

  const record = await requests.get(id);
  const status = decision === 'approve' ? 'approved' : 'rejected';

  let created = null;
  if (status === 'approved') {
    // The repository is attributed to whoever asked for it, not to whoever
    // approved it; the approver is recorded on the request itself.
    const requester = await auth.findUser(record.requestedBy);
    if (!requester) {
      throw new ValidationError('the account that made this request no longer exists');
    }

    // Create first. If this throws, the request stays pending so an admin can
    // retry, rather than leaving a queue full of approvals that never
    // materialised.
    created = await provision.create({
      name: record.name,
      description: record.description,
      template: record.template,
      author: requester,
    });
  }

  const updated = await requests.decide(id, status, auth.publicUser(req.user), req.body.note);

  if (created) {
    return res.redirect(302, `/${created.id}`);
  }
  return res.redirect(302, '/admin');
}));

/* ------------------------------------------------------------------ api */

export default router;
export { NotFoundError };
