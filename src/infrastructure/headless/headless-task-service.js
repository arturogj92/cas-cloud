const crypto = require('crypto');

const TASK_STATUSES = new Set(['pending', 'in_progress', 'in_testing', 'completed']);

function text(value, label, max, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return undefined;
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function taskId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Task id is invalid');
  return id;
}

function labels(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) throw new Error('Task labels are invalid');
  return value.map((label) => {
    if (typeof label === 'string') return text(label, 'Task label', 100);
    if (!label || typeof label !== 'object' || Array.isArray(label)
      || Object.keys(label).some((key) => !['text', 'color'].includes(key))
      || !Number.isSafeInteger(label.color) || label.color < 0 || label.color > 7) {
      throw new Error('Task label is invalid');
    }
    return { text: text(label.text, 'Task label', 100), color: label.color };
  });
}

class HeadlessTaskService {
  constructor({ database, projectRegistry, changed = () => {} }) {
    this.database = database;
    this.projects = projectRegistry;
    this.changed = changed;
  }

  _project(projectId) { return this.projects.resolveProject(projectId); }

  _task(project, id) {
    const task = this.database.getTaskById(taskId(id));
    if (!task || task.project !== project.taskProjectName) throw new Error('Task was not found in this remote project');
    return task;
  }

  _request(type, payload, requestId, mutate, changedProjectIds = [payload.projectId]) {
    const hash = crypto.createHash('sha256').update(JSON.stringify([`task.${type}`, payload])).digest('hex');
    const duplicate = this.projects._request(requestId, hash);
    if (duplicate) return duplicate;
    const recorded = this.database.db.transaction(() => {
      const result = mutate();
      if (!result?.success) throw new Error(result?.error || `Remote task ${type} failed`);
      return this.projects._recordRequest(requestId, hash, result);
    })();
    for (const projectId of new Set(changedProjectIds)) {
      if (this.deferredChanges) this.deferredChanges.add(projectId);
      else this.changed(projectId);
    }
    return recorded;
  }

  create({ projectId, title, description = '', parentTaskId = null, labels: rawLabels = [], status, plan, implementation, requestId }) {
    const project = this._project(projectId);
    const payload = {
      projectId,
      title: text(title, 'Task title', 500),
      description: text(description, 'Task description', 4_000, { optional: true }) || '',
      parentTaskId: parentTaskId == null ? null : taskId(parentTaskId),
      labels: labels(rawLabels) || [],
      ...(status !== undefined ? { status: text(status, 'Task status', 32) } : {}),
      ...(plan !== undefined ? { plan: text(plan, 'Task plan', 4_000, { optional: true }) || '' } : {}),
      ...(implementation !== undefined ? { implementation: text(implementation, 'Task implementation', 4_000, { optional: true }) || '' } : {}),
    };
    if (payload.status && !TASK_STATUSES.has(payload.status)) throw new Error('Task status is invalid');
    if (payload.parentTaskId) this._task(project, payload.parentTaskId);
    return this._request('create', payload, requestId, () => {
      const created = this.database.createTask(
        payload.title,
        payload.description,
        null,
        project.taskProjectName,
        payload.parentTaskId,
        payload.labels,
      );
      if (!created?.success) return created;
      const operations = [
        ...(payload.status !== undefined ? [this.database.updateTaskStatus(created.taskId, payload.status)] : []),
        ...(payload.plan !== undefined ? [this.database.updateTaskPlan(created.taskId, payload.plan)] : []),
        ...(payload.implementation !== undefined ? [this.database.updateTaskImplementation(created.taskId, payload.implementation)] : []),
      ];
      return operations.find((result) => !result?.success) || created;
    });
  }

  mutate({ operations, requestId }) {
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 100) {
      throw new Error('Task mutations are invalid');
    }
    const allowed = {
      create: new Set(['type', 'projectId', 'title', 'description', 'parentTaskId', 'labels', 'status', 'plan', 'implementation']),
      update: new Set(['type', 'projectId', 'id', 'targetProjectId', 'title', 'description', 'status', 'plan', 'implementation', 'labels', 'parentTaskId', 'sortOrder']),
      delete: new Set(['type', 'projectId', 'id']),
    };
    for (const operation of operations) {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)
        || !allowed[operation.type]
        || Object.keys(operation).some((key) => !allowed[operation.type].has(key))) {
        throw new Error('Task mutation is invalid');
      }
    }
    const changed = new Set();
    const previous = this.deferredChanges;
    this.deferredChanges = changed;
    try {
      const result = this._request('mutate', { operations }, requestId, () => {
        const results = operations.map(({ type, ...operation }, index) => {
          const childRequestId = crypto.createHash('sha256')
            .update(`${requestId}\0${index}`)
            .digest('base64url');
          return this[type]({ ...operation, requestId: childRequestId });
        });
        return { success: true, results };
      }, []);
      if (previous) for (const projectId of changed) previous.add(projectId);
      else for (const projectId of changed) this.changed(projectId);
      return result;
    } finally {
      this.deferredChanges = previous;
    }
  }

  update({ projectId, id, targetProjectId, title, description, status, plan, implementation, labels: rawLabels, parentTaskId, sortOrder, requestId }) {
    const project = this._project(projectId);
    const targetProject = targetProjectId === undefined ? project : this._project(targetProjectId);
    const current = this._task(project, id);
    const patch = {
      ...(targetProjectId !== undefined ? { targetProjectId: targetProject.projectId } : {}),
      ...(title !== undefined ? { title: text(title, 'Task title', 500) } : {}),
      ...(description !== undefined ? { description: text(description, 'Task description', 4_000, { optional: true }) || '' } : {}),
      ...(status !== undefined ? { status: text(status, 'Task status', 32) } : {}),
      ...(plan !== undefined ? { plan: text(plan, 'Task plan', 4_000, { optional: true }) || '' } : {}),
      ...(implementation !== undefined ? { implementation: text(implementation, 'Task implementation', 4_000, { optional: true }) || '' } : {}),
      ...(rawLabels !== undefined ? { labels: labels(rawLabels) } : {}),
      ...(parentTaskId !== undefined ? { parentTaskId: parentTaskId == null ? null : taskId(parentTaskId) } : {}),
      ...(sortOrder !== undefined ? { sortOrder: Number(sortOrder) } : {}),
    };
    if (!Object.keys(patch).length) throw new Error('Task update is empty');
    if (patch.status && !TASK_STATUSES.has(patch.status)) throw new Error('Task status is invalid');
    if (patch.parentTaskId) this._task(targetProject, patch.parentTaskId);
    if (patch.parentTaskId === current.id) throw new Error('A task cannot be its own parent');
    if (patch.sortOrder !== undefined && (!Number.isSafeInteger(patch.sortOrder) || patch.sortOrder < 0)) throw new Error('Task order is invalid');
    const payload = { projectId, id: current.id, ...patch };
    return this._request('update', payload, requestId, () => {
      const operations = [];
      if (patch.title !== undefined || patch.description !== undefined) operations.push(this.database.updateTask(
        current.id,
        patch.title ?? current.title,
        patch.description ?? current.description ?? '',
      ));
      if (patch.status !== undefined) operations.push(this.database.updateTaskStatus(current.id, patch.status));
      if (patch.plan !== undefined) operations.push(this.database.updateTaskPlan(current.id, patch.plan));
      if (patch.implementation !== undefined) operations.push(this.database.updateTaskImplementation(current.id, patch.implementation));
      if (patch.labels !== undefined) operations.push(this.database.updateTaskLabels(current.id, patch.labels));
      if (patch.targetProjectId !== undefined && targetProject.taskProjectName !== project.taskProjectName) {
        operations.push(this.database.updateTaskProject(current.id, targetProject.taskProjectName));
      }
      if (patch.parentTaskId !== undefined) operations.push(patch.parentTaskId === null
        ? this.database.unlinkTaskFromParent(current.id)
        : this.database.linkTaskToParent(current.id, patch.parentTaskId));
      if (patch.sortOrder !== undefined) operations.push(this.database.updateTasksOrder([{ taskId: current.id, sortOrder: patch.sortOrder }]));
      const failed = operations.find((result) => !result?.success);
      return failed || { success: true, taskId: current.id };
    }, [project.projectId, targetProject.projectId]);
  }

  delete({ projectId, id, requestId }) {
    const project = this._project(projectId);
    const current = this._task(project, id);
    if (current.images?.length) throw new Error('Tasks with images cannot be deleted remotely');
    const payload = { projectId, id: current.id };
    return this._request('delete', payload, requestId, () => this.database.bulkDeleteTasks([current.id]));
  }
}

module.exports = { HeadlessTaskService, TASK_STATUSES };
