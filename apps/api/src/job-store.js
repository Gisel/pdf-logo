// In-memory job storage (no Redis needed)
const jobs = new Map();

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function setJob(jobId, data) {
  const existing = jobs.get(jobId) || {};
  jobs.set(jobId, { ...existing, ...data });
}

export function updateJob(jobId, data) {
  setJob(jobId, data);
}
