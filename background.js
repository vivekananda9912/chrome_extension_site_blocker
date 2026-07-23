// background.js
// Load shared config into the service worker
try { importScripts('config.js'); } catch (e) { }
// Using Firebase REST only for Firestore writes (no SDK loaded)
const MAX_LOGS = 10000;
// Load CONFIG if available (from config.js)
const HEARTBEAT_MINUTES = (self.CONFIG && self.CONFIG.HEARTBEAT_MINUTES) || 1;
const BACKEND_BASE = (self.CONFIG && self.CONFIG.BACKEND_BASE) || "";

function isPlaceholderValue(value) {
  return !value || /your-backend\.com|G-XXXXXXXXXX|ABCDEFGHIJKLMNOPQRSTUVWXYZ/.test(String(value));
}

function getConfiguredBackendBase() {
  return isPlaceholderValue(BACKEND_BASE) ? "" : BACKEND_BASE;
}

function withRequiredRules(lines = []) {
  const normalized = Array.isArray(lines)
    ? lines.map(line => String(line || '').trim()).filter(Boolean)
    : [];

  if (self.CONFIG && Array.isArray(self.CONFIG.REQUIRED_RULES)) {
    const set = new Set(normalized);
    self.CONFIG.REQUIRED_RULES.forEach(rule => set.add(rule));
    return Array.from(set);
  }

  return Array.from(new Set(normalized));
}

// Generate or fetch persistent device ID
async function getOrCreateDeviceId() {
  const { deviceId } = await chrome.storage.local.get("deviceId");
  if (deviceId) return deviceId;

  const newId = crypto.getRandomValues(new Uint8Array(16))
    .reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  await chrome.storage.local.set({ deviceId: newId });
  return newId;
}

/**
 * Send event to GA4 via Measurement Protocol
 * - Requires CONFIG.GA4.measurement_id and CONFIG.GA4.api_secret
 * - Uses deviceId as client_id to identify the device in GA
 */
async function sendToGA(eventName, eventParams = {}) {
  try {
    if (!self.CONFIG || !self.CONFIG.GA4) return false;
    const { measurement_id, api_secret } = self.CONFIG.GA4;
    if (isPlaceholderValue(measurement_id) || isPlaceholderValue(api_secret)) return false;

    // client_id: use deviceId (persistent) or generate fallback
    const deviceId = await getOrCreateDeviceId(); // you already have this helper
    const client_id = deviceId || `${Math.floor(Math.random() * 1e10)}`;

    const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(measurement_id)}&api_secret=${encodeURIComponent(api_secret)}`;

    const body = {
      client_id,
      events: [{
        name: eventName,
        params: eventParams
      }]
    };

    // fetch with keepalive so the service worker can send it even when unloading
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true
    });

    return true;
  } catch (err) {
    console.warn('[LabPolicy] sendToGA failed', err);
    return false;
  }
}
// ==== Firebase direct REST helpers (anonymous auth + write to Firestore) ====
// We obtain an access_token suitable for Firestore by first doing anonymous
// sign-in to get a refresh_token, then exchanging it via STS to an access token.
async function getFirebaseAccessToken() {
  const now = Date.now();
  const { fbToken = null } = await chrome.storage.local.get('fbToken');
  if (fbToken && fbToken.access && fbToken.access.expiresAt - 60_000 > now) {
    return fbToken.access.token;
  }
  if (!self.CONFIG || !self.CONFIG.FIREBASE) return null;
  const apiKey = self.CONFIG.FIREBASE.apiKey;
  try {
    let refreshToken = fbToken?.refreshToken;
    if (!refreshToken) {
      // Anonymous sign-in for a fresh refresh token
      const res = await fetch(`${self.CONFIG.FIREBASE.rest.identityToolkit}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true })
      });
      if (!res.ok) return null;
      const json = await res.json();
      refreshToken = json.refreshToken;
    }
    // Exchange refresh token for Google OAuth access token
    const tokenRes = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
    });
    if (!tokenRes.ok) return null;
    const tokenJson = await tokenRes.json();
    const accessToken = tokenJson.access_token;
    const expiresInMs = parseInt(tokenJson.expires_in || '3600', 10) * 1000;
    const record = { refreshToken, access: { token: accessToken, expiresAt: now + expiresInMs } };
    await chrome.storage.local.set({ fbToken: record });
    return accessToken;
  } catch (e) {
    return null;
  }
}
async function writeLogToFirestore(payload) {
  if (!self.CONFIG || !self.CONFIG.FIREBASE) return;
  const accessToken = await getFirebaseAccessToken();
  if (!accessToken) return;
  const projectId = self.CONFIG.FIREBASE.projectId;
  const endpoint = `${self.CONFIG.FIREBASE.rest.firestoreBase}/projects/${projectId}/databases/(default)/documents/logs`;
  const fields = {
    url: { stringValue: String(payload.url || '') },
    title: { stringValue: String(payload.title || '') },
    allowed: { booleanValue: !!payload.allowed },
    classCode: { stringValue: String(payload.classCode || '') },
    rollNumber: { stringValue: String(payload.rollNumber || '') },
    pcCode: { stringValue: String(payload.pcCode || '') },
    deviceId: { stringValue: String(payload.deviceId || '') },
    prompt: { stringValue: String(payload.prompt || '') },
    ts: { timestampValue: new Date(payload.ts || Date.now()).toISOString() }
  };
  if (payload.studentCode !== undefined && payload.studentCode !== null) {
    fields.studentCode = { stringValue: String(payload.studentCode) };
  }
  const doc = { fields };
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(doc),
      keepalive: true
    });
    if (!res.ok) {
      console.warn('Firestore write failed', res.status, await res.text());
    }
  } catch (e) {}
}

function hashString(value) {
  let hash = 5381;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function sanitizeFirestoreDocId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

function getCodeHelpRequestId({ classCode, rollNumber, pageUrl }) {
  return [
    sanitizeFirestoreDocId(classCode),
    sanitizeFirestoreDocId(rollNumber),
    hashString(pageUrl)
  ].join('_');
}
function jsToFirestoreValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
      return { timestampValue: value };
    }
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(jsToFirestoreValue).filter(Boolean)
      }
    };
  }
  if (typeof value === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(value)) {
      const fVal = jsToFirestoreValue(v);
      if (fVal) fields[k] = fVal;
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function buildFirestoreFields(data) {
  const fields = {};
  Object.entries(data).forEach(([key, value]) => {
    const fVal = jsToFirestoreValue(value);
    if (fVal) {
      fields[key] = fVal;
    }
  });
  return fields;
}

function firestoreValueToJs(value) {
  if (!value || typeof value !== 'object') return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) {
    const vals = value.arrayValue.values || [];
    return vals.map(firestoreValueToJs);
  }
  if ('mapValue' in value) {
    const fields = value.mapValue.fields || {};
    return Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, firestoreValueToJs(v)])
    );
  }
  return undefined;
}

function firestoreFieldsToJs(fields = {}) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, firestoreValueToJs(value)])
  );
}
async function saveStudentCodeHelpRequest(payload) {
  if (!self.CONFIG || !self.CONFIG.FIREBASE) {
    return { success: false, message: 'Firebase is not configured.' };
  }

  const accessToken = await getFirebaseAccessToken();
  if (!accessToken) {
    return { success: false, message: 'Unable to authenticate with Firebase.' };
  }
  const projectId = self.CONFIG.FIREBASE.projectId;
  const requestId = getCodeHelpRequestId(payload);
  const endpoint = `${self.CONFIG.FIREBASE.rest.firestoreBase}/projects/${projectId}/databases/(default)/documents/codeHelpRequests/${encodeURIComponent(requestId)}`;
  const now = new Date();
  const fields = buildFirestoreFields({
    requestId,
    status: 'student_requested_help',
    classCode: payload.classCode,
    rollNumber: payload.rollNumber,
    pcCode: payload.pcCode,
    deviceId: payload.deviceId,
    pageUrl: payload.pageUrl,
    pageTitle: payload.pageTitle,
    studentCode: payload.code,
    updatedAt: now,
    lastStudentSentAt: now
  });
  console.log('[site-blocker] saveStudentCodeHelpRequest writing Firestore document', {
    requestId,
    classCode: payload.classCode,
    rollNumber: payload.rollNumber,
    pageUrl: payload.pageUrl,
    codeLength: String(payload.code || '').length,
  });
  const updateMask = Object.keys(fields)
    .map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`)
    .join('&');
  const res = await fetch(`${endpoint}?${updateMask}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ fields }),
    keepalive: true
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.warn('[site-blocker] saveStudentCodeHelpRequest Firestore write failed', res.status, errorText);
    return { success: false, message: 'Firestore write failed.' };
  }

  await writeLogToFirestore({
    url: payload.pageUrl,
    title: 'W3Schools Code Help Request',
    allowed: true,
    classCode: payload.classCode,
    rollNumber: payload.rollNumber,
    pcCode: payload.pcCode,
    deviceId: payload.deviceId,
    prompt: `W3Schools code help requested for ${payload.pageTitle || payload.pageUrl}`,
    ts: Date.now(),
    studentCode: payload.code
  });

  console.log('[site-blocker] saveStudentCodeHelpRequest Firestore write complete', { requestId });
  return { success: true, requestId };
}

async function fetchTeacherCodeHelpResponse(payload) {
  if (!self.CONFIG || !self.CONFIG.FIREBASE) {
    return { success: false, message: 'Firebase is not configured.' };
  }

  const accessToken = await getFirebaseAccessToken();
  if (!accessToken) {
    return { success: false, message: 'Unable to authenticate with Firebase.' };
  }

  const projectId = self.CONFIG.FIREBASE.projectId;
  const requestId = getCodeHelpRequestId(payload);
  const endpoint = `${self.CONFIG.FIREBASE.rest.firestoreBase}/projects/${projectId}/databases/(default)/documents/codeHelpRequests/${encodeURIComponent(requestId)}`;

  console.log('[site-blocker] fetchTeacherCodeHelpResponse reading Firestore document', {
    requestId,
    classCode: payload.classCode,
    rollNumber: payload.rollNumber,
    pageUrl: payload.pageUrl,
  });

  const res = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (res.status === 404) {
    console.log('[site-blocker] fetchTeacherCodeHelpResponse no request document found', { requestId });
    return { success: false, message: 'No code request found for this page yet.' };
  }

  if (!res.ok) {
    const errorText = await res.text();
    console.warn('[site-blocker] fetchTeacherCodeHelpResponse Firestore read failed', res.status, errorText);
    return { success: false, message: 'Firestore read failed.' };
  }

  const data = await res.json();
  const fields = firestoreFieldsToJs(data.fields);
  const teacherCode = fields.teacherCode || fields.modifiedCode || fields.teacherModifiedCode || '';

  console.log('[site-blocker] fetchTeacherCodeHelpResponse read complete', {
    requestId,
    hasTeacherCode: Boolean(String(teacherCode || '').trim()),
    teacherCodeLength: String(teacherCode || '').length,
    status: fields.status || '',
  });

  if (!String(teacherCode || '').trim()) {
    return { success: false, message: 'Teacher has not added modified code yet.', requestId };
  }

  return {
    success: true,
    requestId,
    code: teacherCode,
    status: fields.status || '',
    updatedAt: fields.updatedAt || ''
  };
}

async function dbAskClassQuestion(payload) {
  if (!self.CONFIG || !self.CONFIG.FIREBASE) {
    return { success: false, message: 'Firebase is not configured.' };
  }
  const accessToken = await getFirebaseAccessToken();
  if (!accessToken) {
    return { success: false, message: 'Unable to authenticate with Firebase.' };
  }
  const projectId = self.CONFIG.FIREBASE.projectId;
  const endpoint = `${self.CONFIG.FIREBASE.rest.firestoreBase}/projects/${projectId}/databases/(default)/documents/questions`;
  
  const fields = buildFirestoreFields({
    classCode: payload.classCode,
    rollNumber: payload.rollNumber,
    questionTitle: payload.questionTitle,
    questionDescription: payload.questionDescription,
    studentCode: payload.studentCode,
    createdTime: new Date(),
    status: 'Open',
    repliesCount: 0
  });

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ fields })
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.warn('[dbAskClassQuestion] Firestore write failed', res.status, errorText);
    return { success: false, message: 'Failed to save question to Firestore.' };
  }

  const json = await res.json();
  const nameParts = json.name.split('/');
  const questionId = nameParts[nameParts.length - 1];
  return { success: true, questionId };
}

async function dbFetchOpenQuestions(classCode, limit = 10, offset = 0) {
  if (!self.CONFIG || !self.CONFIG.FIREBASE) return [];
  const accessToken = await getFirebaseAccessToken();
  if (!accessToken) return [];
  const projectId = self.CONFIG.FIREBASE.projectId;
  const endpoint = `${self.CONFIG.FIREBASE.rest.firestoreBase}/projects/${projectId}/databases/(default)/documents:runQuery`;

  const queryPayload = {
    structuredQuery: {
      from: [{ collectionId: "questions" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: "classCode" },
                op: "EQUAL",
                value: { stringValue: classCode }
              }
            },
            {
              fieldFilter: {
                field: { fieldPath: "status" },
                op: "EQUAL",
                value: { stringValue: "Open" }
              }
            }
          ]
        }
      },
      limit: limit,
      offset: offset
    }
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify(queryPayload)
  });

  if (!res.ok) {
    console.warn('[dbFetchOpenQuestions] Firestore query failed', res.status);
    return [];
  }

  const data = await res.json();
  const questions = [];
  if (Array.isArray(data)) {
    data.forEach(item => {
      if (item.document) {
        const doc = item.document;
        const fields = firestoreFieldsToJs(doc.fields);
        const nameParts = doc.name.split('/');
        const id = nameParts[nameParts.length - 1];
        questions.push({ id, ...fields });
      }
    });
  }

  questions.sort((a, b) => {
    const tA = new Date(a.createdTime || 0).getTime();
    const tB = new Date(b.createdTime || 0).getTime();
    return tB - tA;
  });

  return questions;
}

async function dbSubmitAnswer(payload) {
  if (!self.CONFIG || !self.CONFIG.FIREBASE) {
    return { success: false, message: 'Firebase is not configured.' };
  }
  const accessToken = await getFirebaseAccessToken();
  if (!accessToken) {
    return { success: false, message: 'Unable to authenticate with Firebase.' };
  }
  const projectId = self.CONFIG.FIREBASE.projectId;
  const { questionId, correctedCode, explanation, authorId, authorName } = payload;
  
  const endpoint = `${self.CONFIG.FIREBASE.rest.firestoreBase}/projects/${projectId}/databases/(default)/documents/questions/${questionId}/responses`;
  const fields = buildFirestoreFields({
    authorType: 'student',
    authorId,
    authorName,
    correctedCode,
    explanation,
    timestamp: new Date()
  });

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ fields })
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.warn('[dbSubmitAnswer] Firestore write response failed', res.status, errorText);
    return { success: false, message: 'Failed to submit response to Firestore.' };
  }

  const questionEndpoint = `${self.CONFIG.FIREBASE.rest.firestoreBase}/projects/${projectId}/databases/(default)/documents/questions/${questionId}`;
  const getRes = await fetch(questionEndpoint, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (getRes.ok) {
    const qData = await getRes.json();
    const qFields = firestoreFieldsToJs(qData.fields);
    const currentReplies = Number(qFields.repliesCount || 0);
    const newReplies = currentReplies + 1;

    const updateFields = buildFirestoreFields({ repliesCount: newReplies });
    await fetch(`${questionEndpoint}?updateMask.fieldPaths=repliesCount`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({ fields: updateFields })
    });
  }

  return { success: true };
}

async function dbFetchMyQuestions(classCode, rollNumber, limit = 10, offset = 0) {
  if (!self.CONFIG || !self.CONFIG.FIREBASE) return [];
  const accessToken = await getFirebaseAccessToken();
  if (!accessToken) return [];
  const projectId = self.CONFIG.FIREBASE.projectId;
  const endpoint = `${self.CONFIG.FIREBASE.rest.firestoreBase}/projects/${projectId}/databases/(default)/documents:runQuery`;

  const queryPayload = {
    structuredQuery: {
      from: [{ collectionId: "questions" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: "classCode" },
                op: "EQUAL",
                value: { stringValue: classCode }
              }
            },
            {
              fieldFilter: {
                field: { fieldPath: "rollNumber" },
                op: "EQUAL",
                value: { stringValue: rollNumber }
              }
            }
          ]
        }
      },
      limit: limit,
      offset: offset
    }
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify(queryPayload)
  });

  if (!res.ok) {
    console.warn('[dbFetchMyQuestions] Firestore query failed', res.status);
    return [];
  }

  const data = await res.json();
  const questions = [];
  if (Array.isArray(data)) {
    data.forEach(item => {
      if (item.document) {
        const doc = item.document;
        const fields = firestoreFieldsToJs(doc.fields);
        const nameParts = doc.name.split('/');
        const id = nameParts[nameParts.length - 1];
        questions.push({ id, ...fields });
      }
    });
  }

  questions.sort((a, b) => {
    const tA = new Date(a.createdTime || 0).getTime();
    const tB = new Date(b.createdTime || 0).getTime();
    return tB - tA;
  });

  return questions;
}

async function dbFetchQuestionResponses(questionId, limit = 10, offset = 0) {
  if (!self.CONFIG || !self.CONFIG.FIREBASE) return [];
  const accessToken = await getFirebaseAccessToken();
  if (!accessToken) return [];
  const projectId = self.CONFIG.FIREBASE.projectId;
  
  const endpoint = `${self.CONFIG.FIREBASE.rest.firestoreBase}/projects/${projectId}/databases/(default)/documents/questions/${questionId}:runQuery`;
  const queryPayload = {
    structuredQuery: {
      from: [{ collectionId: "responses", allDescendants: false }],
      limit: limit,
      offset: offset
    }
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify(queryPayload)
  });

  if (!res.ok) {
    console.warn('[dbFetchQuestionResponses] Firestore query failed', res.status);
    return [];
  }

  const data = await res.json();
  const responses = [];
  if (Array.isArray(data)) {
    data.forEach(item => {
      if (item.document) {
        const doc = item.document;
        const fields = firestoreFieldsToJs(doc.fields);
        const nameParts = doc.name.split('/');
        const id = nameParts[nameParts.length - 1];
        responses.push({ id, ...fields });
      }
    });
  }

  responses.sort((a, b) => {
    const tA = new Date(a.timestamp || 0).getTime();
    const tB = new Date(b.timestamp || 0).getTime();
    return tB - tA;
  });

  return responses;
}

async function dbAcceptAnswer(payload) {
  if (!self.CONFIG || !self.CONFIG.FIREBASE) {
    return { success: false, message: 'Firebase is not configured.' };
  }
  const accessToken = await getFirebaseAccessToken();
  if (!accessToken) {
    return { success: false, message: 'Unable to authenticate with Firebase.' };
  }
  const projectId = self.CONFIG.FIREBASE.projectId;
  const { questionId, responseId, helperRollNumber, classCode } = payload;

  const questionEndpoint = `${self.CONFIG.FIREBASE.rest.firestoreBase}/projects/${projectId}/databases/(default)/documents/questions/${questionId}`;
  const now = new Date();
  
  const updateFields = buildFirestoreFields({
    status: 'Solved',
    acceptedResponseId: responseId,
    acceptedBy: helperRollNumber,
    acceptedAt: now
  });

  const res = await fetch(`${questionEndpoint}?updateMask.fieldPaths=status&updateMask.fieldPaths=acceptedResponseId&updateMask.fieldPaths=acceptedBy&updateMask.fieldPaths=acceptedAt`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ fields: updateFields })
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.warn('[dbAcceptAnswer] PATCH question failed', res.status, errorText);
    return { success: false, message: 'Failed to update question status.' };
  }

  const pointsDocId = sanitizeFirestoreDocId(classCode) + '_' + sanitizeFirestoreDocId(helperRollNumber);
  const pointsEndpoint = `${self.CONFIG.FIREBASE.rest.firestoreBase}/projects/${projectId}/databases/(default)/documents/studentPoints/${encodeURIComponent(pointsDocId)}`;
  
  const pointsRes = await fetch(pointsEndpoint, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  let currentPoints = 0;
  let currentSolutions = 0;
  if (pointsRes.ok) {
    const pData = await pointsRes.json();
    const pFields = firestoreFieldsToJs(pData.fields);
    currentPoints = Number(pFields.points || 0);
    currentSolutions = Number(pFields.acceptedSolutions || 0);
  }

  const newPoints = currentPoints + 10;
  const newSolutions = currentSolutions + 1;

  const ptsFields = buildFirestoreFields({
    classCode,
    rollNumber: helperRollNumber,
    points: newPoints,
    acceptedSolutions: newSolutions
  });

  const ptsMask = 'updateMask.fieldPaths=classCode&updateMask.fieldPaths=rollNumber&updateMask.fieldPaths=points&updateMask.fieldPaths=acceptedSolutions';
  await fetch(`${pointsEndpoint}?${ptsMask}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ fields: ptsFields })
  });

  return { success: true };
}

/**
 * Fetch class details from Firestore based on class code.
 * Returns an object with the class name, wishlist array, and a found boolean indicator.
 */
async function fetchClassDetails(classCode) {
  if (!classCode) return { found: false, wishlist: [], className: "" };

  const accessToken = await getFirebaseAccessToken();
  if (!accessToken || !self.CONFIG || !self.CONFIG.FIREBASE) {
    return { found: false, wishlist: [], className: "" };
  }

  try {
    const projectId = self.CONFIG.FIREBASE.projectId;
    // Query the classes collection for the document with the matching code field
    const endpoint = `${self.CONFIG.FIREBASE.rest.firestoreBase}/projects/${projectId}/databases/(default)/documents:runQuery`;

    const queryPayload = {
      structuredQuery: {
        from: [{ collectionId: "classes" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "code" },
            op: "EQUAL",
            value: { stringValue: classCode }
          }
        }
      }
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(queryPayload)
    });

    if (!res.ok) {
      console.warn('[fetchClassDetails] Firestore query failed', res.status);
      return { found: false, wishlist: [], className: "" };
    }

    const data = await res.json();

    if (data && Array.isArray(data) && data.length > 0 && data[0].document) {
      const doc = data[0].document;
      const wishlistField = doc.fields?.wishlist?.arrayValue?.values;
      const classNameField = doc.fields?.name?.stringValue;

      const wishlist = wishlistField && Array.isArray(wishlistField)
        ? wishlistField.map(item => item.stringValue).filter(Boolean)
        : [];
      const className = classNameField || "";

      console.log('[fetchClassDetails] Found details for class', classCode, className, wishlist);
      return { found: true, wishlist, className };
    }

    console.log('[fetchClassDetails] No class document found for class code', classCode);
    return { found: false, wishlist: [], className: "" };
  } catch (err) {
    console.warn('[fetchClassDetails] error', err);
    return { found: false, wishlist: [], className: "" };
  }
}

/**
 * Get combined whitelist: local admin whitelist + student's class wishlist from Firestore
 */
async function getCombinedWhitelist() {
  // Get local admin whitelist
  const { whitelist = [] } = await chrome.storage.local.get('whitelist');
  let combined = [...whitelist];

  // Add required rules
  if (self.CONFIG && Array.isArray(self.CONFIG.REQUIRED_RULES)) {
    combined = [...combined, ...self.CONFIG.REQUIRED_RULES];
  }

  // Get student's class code and fetch their class wishlist
  const { studentInfo = {} } = await chrome.storage.local.get('studentInfo');
  if (studentInfo.classCode) {
    // Check cache first (valid for 5 minutes)
    const { classWishlistCache } = await chrome.storage.local.get('classWishlistCache');
    const now = Date.now();

    if (classWishlistCache &&
      classWishlistCache.classCode === studentInfo.classCode &&
      classWishlistCache.timestamp > now - 5 * 60 * 1000) {
      // Use cached wishlist
      console.log('[getCombinedWhitelist] Using cached wishlist');
      combined = [...combined, ...classWishlistCache.wishlist];
    } else {
      // Fetch fresh wishlist from Firestore
      console.log('[getCombinedWhitelist] Fetching details for class:', studentInfo.classCode);
      const details = await fetchClassDetails(studentInfo.classCode);
      combined = [...combined, ...details.wishlist];

      // Asynchronously self-heal/update the stored className if we found it
      if (details.found && details.className && studentInfo.className !== details.className) {
        studentInfo.className = details.className;
        await chrome.storage.local.set({ studentInfo });
      }

      // Cache the result
      await chrome.storage.local.set({
        classWishlistCache: {
          classCode: studentInfo.classCode,
          wishlist: details.wishlist,
          className: details.className,
          timestamp: now
        }
      });
    }
  }

  return Array.from(new Set(combined));
}

async function postJSON(path, data) {
  const backendBase = getConfiguredBackendBase();
  if (!backendBase) return false;
  try {
    const res = await fetch(`${backendBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      keepalive: true,
    });
    return res.ok;
  } catch (e) {
    // Swallow network errors; will retry on next alarm
    return false;
  }
}

// On install: register device, set uninstall URL, and start heartbeat alarm
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[LabPolicy] service worker installed');
  const id = await getOrCreateDeviceId();
  const backendBase = getConfiguredBackendBase();
  if (backendBase) {
    await postJSON("/install", { id, ts: Date.now() });
  }

  // Set uninstall callback URL
  try {
    if (backendBase) {
      chrome.runtime.setUninstallURL(`${backendBase}/uninstalled?id=${encodeURIComponent(id)}`);
    }
  } catch (e) { }

  // Create repeating heartbeat alarm
  chrome.alarms.create("heartbeat", { periodInMinutes: HEARTBEAT_MINUTES });
});

// On browser startup
chrome.runtime.onStartup.addListener(() => {
  console.log('[LabPolicy] service worker startup');
});

// Heartbeat on alarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "heartbeat") return;
  const id = await getOrCreateDeviceId();
  const ts = Date.now();
  const ok = await postJSON(`/heartbeat`, { id, ts });
  await chrome.storage.local.set({ lastHeartbeat: { ts, ok } });
});

// Message API for options page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message && message.type === "getDeviceStatus") {
      const id = await getOrCreateDeviceId();
      const { lastHeartbeat = null } = await chrome.storage.local.get("lastHeartbeat");
      sendResponse({ id, lastHeartbeat });
    } else if (message && message.type === "heartbeatNow") {
      const id = await getOrCreateDeviceId();
      const ts = Date.now();
      const ok = await postJSON(`/heartbeat`, { id, ts });
      await chrome.storage.local.set({ lastHeartbeat: { ts, ok } });
      sendResponse({ ok, ts });
    } else if (message && message.type === "refreshWishlist") {
      // Clear cache to force refresh
      await chrome.storage.local.remove('classWishlistCache');
      const requestedClassCode = String(message.classCode || '').trim();
      const { studentInfo = {} } = await chrome.storage.local.get('studentInfo');
      const classCode = requestedClassCode || studentInfo.classCode || '';

      if (classCode) {
        const details = await fetchClassDetails(classCode);
        if (!details.found) {
          sendResponse({
            success: false,
            message: `Class code "${classCode}" was not found in Firestore.`,
            classCode
          });
          return;
        }

        const { wishlist, className } = details;

        // Retrieve current studentInfo to preserve existing fields like rollNumber
        const { studentInfo: currentInfo = {} } = await chrome.storage.local.get('studentInfo');
        const updatedStudentInfo = {
          ...currentInfo,
          classCode,
          className: className || `Class ${classCode}`
        };

        await chrome.storage.local.set({
          studentInfo: updatedStudentInfo,
          whitelist: withRequiredRules(wishlist),
          classWishlistCache: {
            classCode,
            wishlist,
            className,
            timestamp: Date.now()
          }
        });
        sendResponse({ success: true, wishlist, classCode, className });
      } else {
        sendResponse({ success: false, message: 'No class code set' });
      }
    } else if (message && message.type === "logChatGptPrompt") {
      // Legacy handler — kept for backward compatibility, delegates to logAiPrompt logic
      const prompt = String(message.prompt || '').trim();
      if (!prompt) {
        console.log('[site-blocker] logChatGptPrompt skipped: empty prompt');
        sendResponse({ success: false, message: 'No prompt provided' });
        return;
      }

      console.log('[site-blocker] logChatGptPrompt received', { prompt });
      const deviceId = await getOrCreateDeviceId();
      const { pcCode = '' } = await chrome.storage.local.get('pcCode');
      const { studentInfo = {} } = await chrome.storage.local.get('studentInfo');

      await writeLogToFirestore({
        url: 'https://chatgpt.com/',
        title: 'ChatGPT Prompt',
        allowed: true,
        classCode: studentInfo.classCode || '',
        rollNumber: studentInfo.rollNumber || '',
        pcCode,
        deviceId,
        prompt,
        ts: Date.now()
      });

      console.log('[site-blocker] logChatGptPrompt Firestore write requested');
      sendResponse({ success: true });
    } else if (message && message.type === "logAiPrompt") {
      // Unified handler for ChatGPT, Microsoft Copilot, Google Gemini
      const prompt = String(message.prompt || '').trim();
      const siteName = String(message.siteName || 'AI Tool').trim();
      const siteUrl = String(message.siteUrl || '').trim();

      if (!prompt) {
        console.log(`[site-blocker] logAiPrompt skipped: empty prompt (${siteName})`);
        sendResponse({ success: false, message: 'No prompt provided' });
        return;
      }

      console.log(`[site-blocker] logAiPrompt received from ${siteName}`, { prompt });
      const deviceId = await getOrCreateDeviceId();
      const { pcCode = '' } = await chrome.storage.local.get('pcCode');
      const { studentInfo = {} } = await chrome.storage.local.get('studentInfo');

      await writeLogToFirestore({
        url: siteUrl,
        title: `${siteName} Prompt`,
        allowed: true,
        classCode: studentInfo.classCode || '',
        rollNumber: studentInfo.rollNumber || '',
        pcCode,
        deviceId,
        prompt,
        ts: Date.now()
      });

      console.log(`[site-blocker] logAiPrompt Firestore write requested for ${siteName}`);
      sendResponse({ success: true });
    } else if (message && message.type === "submitStudentCode") {
      const code = String(message.code || '');
      const pageUrl = String(message.pageUrl || sender?.tab?.url || '').trim();
      const pageTitle = String(message.pageTitle || sender?.tab?.title || '').trim();

      console.log('[site-blocker] submitStudentCode received', {
        pageUrl,
        pageTitle,
        codeLength: code.length,
      });

      if (!code.trim()) {
        sendResponse({ success: false, message: 'No code provided' });
        return;
      }

      const deviceId = await getOrCreateDeviceId();
      const { pcCode = '' } = await chrome.storage.local.get('pcCode');
      const { studentInfo = {} } = await chrome.storage.local.get('studentInfo');
      const classCode = String(studentInfo.classCode || '').trim();
      const rollNumber = String(studentInfo.rollNumber || '').trim();

      if (!classCode || !rollNumber) {
        console.warn('[site-blocker] submitStudentCode skipped: missing class or roll', {
          hasClassCode: Boolean(classCode),
          hasRollNumber: Boolean(rollNumber),
        });
        sendResponse({ success: false, message: 'Set class code and roll number first.' });
        return;
      }

      const result = await saveStudentCodeHelpRequest({
        code,
        pageUrl,
        pageTitle,
        classCode,
        rollNumber,
        pcCode,
        deviceId,
      });
      sendResponse(result);
    } else if (message && message.type === "fetchTeacherCode") {
      const pageUrl = String(message.pageUrl || sender?.tab?.url || '').trim();

      console.log('[site-blocker] fetchTeacherCode received', { pageUrl });

      const { studentInfo = {} } = await chrome.storage.local.get('studentInfo');
      const classCode = String(studentInfo.classCode || '').trim();
      const rollNumber = String(studentInfo.rollNumber || '').trim();

      if (!classCode || !rollNumber) {
        console.warn('[site-blocker] fetchTeacherCode skipped: missing class or roll', {
          hasClassCode: Boolean(classCode),
          hasRollNumber: Boolean(rollNumber),
        });
        sendResponse({ success: false, message: 'Set class code and roll number first.' });
        return;
      }

      const result = await fetchTeacherCodeHelpResponse({
        pageUrl,
        classCode,
        rollNumber,
      });
      sendResponse(result);
    } else if (message && message.type === "askClassQuestion") {
      const { studentInfo = {} } = await chrome.storage.local.get('studentInfo');
      const classCode = String(studentInfo.classCode || '').trim();
      const rollNumber = String(studentInfo.rollNumber || '').trim();
      if (!classCode || !rollNumber) {
        sendResponse({ success: false, message: 'Set class code and roll number first.' });
        return;
      }
      const result = await dbAskClassQuestion({
        classCode,
        rollNumber,
        questionTitle: message.title,
        questionDescription: message.description,
        studentCode: message.code
      });
      sendResponse(result);
    } else if (message && message.type === "fetchOpenQuestions") {
      const classCode = String(message.classCode || '').trim();
      const limit = Number(message.limit || 10);
      const offset = Number(message.offset || 0);
      const questions = await dbFetchOpenQuestions(classCode, limit, offset);
      sendResponse({ success: true, questions });
    } else if (message && message.type === "submitAnswer") {
      const { studentInfo = {} } = await chrome.storage.local.get('studentInfo');
      const classCode = String(studentInfo.classCode || '').trim();
      const rollNumber = String(studentInfo.rollNumber || '').trim();
      if (!classCode || !rollNumber) {
        sendResponse({ success: false, message: 'Set class code and roll number first.' });
        return;
      }
      const result = await dbSubmitAnswer({
        questionId: message.questionId,
        correctedCode: message.correctedCode,
        explanation: message.explanation,
        authorId: rollNumber,
        authorName: "Roll " + rollNumber
      });
      sendResponse(result);
    } else if (message && message.type === "fetchMyQuestions") {
      const classCode = String(message.classCode || '').trim();
      const rollNumber = String(message.rollNumber || '').trim();
      const limit = Number(message.limit || 10);
      const offset = Number(message.offset || 0);
      const questions = await dbFetchMyQuestions(classCode, rollNumber, limit, offset);
      sendResponse({ success: true, questions });
    } else if (message && message.type === "fetchQuestionResponses") {
      const questionId = String(message.questionId || '').trim();
      const limit = Number(message.limit || 10);
      const offset = Number(message.offset || 0);
      const responses = await dbFetchQuestionResponses(questionId, limit, offset);
      sendResponse({ success: true, responses });
    } else if (message && message.type === "acceptAnswer") {
      const { studentInfo = {} } = await chrome.storage.local.get('studentInfo');
      const classCode = String(studentInfo.classCode || '').trim();
      const result = await dbAcceptAnswer({
        questionId: message.questionId,
        responseId: message.responseId,
        helperRollNumber: message.helperRollNumber,
        classCode
      });
      sendResponse(result);
    } else if (message && message.type === "openStudentDashboard") {
      const tabName = message.tab || "classQuestions";
      const url = chrome.runtime.getURL(`student_dashboard.html?tab=${tabName}`);
      chrome.tabs.create({ url });
      sendResponse({ success: true });
    } else {
      sendResponse(undefined);
    }
  })();
  return true; // keep channel open for async reply
});

/**
 * Convert a whitelist pattern into a RegExp for URL matching.
 *
 * Supported pattern forms (in priority order):
 *  1. Subdomain wildcard  *.example.com          — matches example.com and any subdomain
 *  2. URL path wildcard   https://site.com/path/* — * matches any suffix in the path/query
 *  3. Exact domain        example.com             — hostname-only match
 *  4. Plain prefix        https://site.com/page   — URL must start with this string
 *  5. Hostname contains   partial                 — hostname contains the string (legacy fallback)
 */
function patternToRegex(pattern) {
  // Subdomain wildcard: *.example.com
  if (pattern.startsWith("*.")) {
    const base = escapeRegex(pattern.slice(2));
    // Matches the base domain or any subdomain
    return new RegExp(`^https?://([^/]+\\.)?${base}(/|$)`, "i");
  }

  // URL with wildcard(s) in path/query: must contain a protocol and a *
  if (/^https?:\/\//.test(pattern) && pattern.includes("*")) {
    // Split on * and escape each segment, then join with .*
    const regexStr = pattern
      .split("*")
      .map(escapeRegex)
      .join(".*");
    return new RegExp(`^${regexStr}`, "i");
  }

  // Exact domain (no slashes, no protocol)
  if (!pattern.includes("/") && !pattern.includes(":")) {
    const escaped = escapeRegex(pattern);
    return new RegExp(`^https?://(([^/]+\\.)?${escaped})(/|$)`, "i");
  }

  // Plain prefix (full URL starts with pattern)
  return new RegExp(`^${escapeRegex(pattern)}`, "i");
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match URL against whitelist patterns
function isAllowed(url, whitelist) {
  try {
    const u = new URL(url);
    for (const rule of whitelist) {
      const pattern = rule.trim();
      if (!pattern) continue;

      try {
        const regex = patternToRegex(pattern);
        if (regex.test(url)) return true;
      } catch (regexErr) {
        // Fallback: legacy plain-string checks
        if (u.hostname === pattern) return true;
        if (url.startsWith(pattern)) return true;
        if (u.hostname.includes(pattern)) return true;
      }
    }
  } catch (e) {
    console.warn("Bad URL:", url);
  }
  return false;
}

// Log visit
async function logVisit(url, title, tabId, allowed) {
  if (
    url.includes('new-tab-page') || 
    url.includes('newtab') || 
    url.startsWith('chrome://') || 
    url.startsWith('edge://') || 
    url.startsWith('file://') || 
    (title && title.toLowerCase() === 'new tab')
  ) {
    return;
  }
  const timestamp = new Date().toISOString();

  try {
    const deviceId = await getOrCreateDeviceId();

    // Read data safely
    const { pcCode = '' } = await chrome.storage.local.get('pcCode');
    const { studentInfo = {} } = await chrome.storage.local.get('studentInfo');

    // Write to Firestore (existing behavior)
    await writeLogToFirestore({
      url,
      title,
      allowed,
      classCode: studentInfo.classCode || '',
      rollNumber: studentInfo.rollNumber || '',
      pcCode,
      deviceId,
      ts: Date.parse(timestamp)
    });

    // Send to Google Analytics
    await sendToGA('site_visit', {
      page_location: String(url || ''),
      page_title: String(title || ''),
      allowed: Boolean(allowed),
      pc_code: String(pcCode || ''),
      class_code: String(studentInfo.classCode || ''),
      roll_number: String(studentInfo.rollNumber || ''),
      device_id: String(deviceId || ''),
      timestamp
    });

  } catch (e) {
    console.warn('[logVisit] failed', e);
  }
}


// Handle navigation
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // only main-frame

  // Ignore navigation to the extension's own URLs and browser internal pages
  if (
    details.url.startsWith(chrome.runtime.getURL('')) || 
    details.url.startsWith('chrome://') || 
    details.url.startsWith('edge://') || 
    details.url.startsWith('about:') ||
    details.url.startsWith('file://') ||
    details.url.includes('new-tab-page') ||
    details.url.includes('newtab')
  ) {
    return;
  }

  console.log('[LabPolicy] onBeforeNavigate', details.url);
  const whitelist = await getCombinedWhitelist();
  const allowed = isAllowed(details.url, whitelist);

  if (!allowed) {
    chrome.tabs.update(details.tabId, {
      url: chrome.runtime.getURL("blocked.html") + "?orig=" + encodeURIComponent(details.url)
    });
  }

  chrome.tabs.get(details.tabId, (tab) => {
    const title = tab?.title || "Untitled";
    console.log('[LabPolicy] logging visit', { url: details.url, allowed });
    logVisit(details.url, title, details.tabId, allowed);
  });
});

// Fallback: also listen to tab updates when a page completes loading
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (tab.url.startsWith(chrome.runtime.getURL(''))) return;
  if (
    tab.url.startsWith('chrome://') || 
    tab.url.startsWith('edge://') || 
    tab.url.startsWith('about:') ||
    tab.url.startsWith('file://') ||
    tab.url.includes('new-tab-page') ||
    tab.url.includes('newtab')
  ) return;
  try {
    console.log('[LabPolicy] tabs.onUpdated complete', tab.url);
    const whitelist = await getCombinedWhitelist();
    const allowed = isAllowed(tab.url, whitelist);
    if (!allowed) {
      chrome.tabs.update(tabId, { url: chrome.runtime.getURL('blocked.html') + '?orig=' + encodeURIComponent(tab.url) });
    }
    logVisit(tab.url, tab.title || 'Untitled', tabId, allowed);
  } catch (e) { }
});
