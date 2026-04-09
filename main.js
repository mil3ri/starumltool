const https = require("https");

const PREF_ENDPOINT = "llmDiagram.endpoint";
const PREF_MODEL = "llmDiagram.model";
const PREF_API_KEY = "llmDiagram.apiKey";

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4.1-mini";
const LLM_MAX_ATTEMPTS = 4;
const LLM_BASE_RETRY_MS = 1500;
const LLM_MAX_RETRY_MS = 15000;

const DIAGRAM_TYPES = [
  { text: "Auto Detect", value: "auto", checked: true },
  { text: "Class Diagram", value: "class" },
  { text: "Use Case Diagram", value: "usecase" },
  { text: "Sequence Diagram", value: "sequence" },
  { text: "ER Diagram", value: "erd" },
  { text: "Flowchart", value: "flowchart" },
];

function getPreference(key, defaultValue) {
  return app.preferences.get(key, defaultValue);
}

function setPreference(key, value) {
  app.preferences.set(key, value);
}

function toErrorMessage(err, fallback) {
  if (typeof err === "string" && err.trim()) {
    return err;
  }
  if (err && typeof err.message === "string" && err.message.trim()) {
    return err.message;
  }
  if (fallback) {
    return fallback;
  }
  return "Unknown error";
}

function compactMessage(message, maxLen) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  const limit = maxLen || 350;
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function extractApiErrorMessage(body) {
  if (!body || typeof body !== "string") {
    return "";
  }

  const raw = body.trim();
  if (!raw) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed[0] && parsed[0].error) {
      return String(parsed[0].error.message || "");
    }
    if (parsed && parsed.error) {
      return String(parsed.error.message || "");
    }
  } catch (_ignore) {
    // Fallback to plain text below.
  }

  return raw;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfterSeconds(value) {
  if (!value) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && numeric > 0) {
    return numeric;
  }
  const dateMs = Date.parse(String(value));
  if (Number.isNaN(dateMs)) {
    return null;
  }
  const seconds = Math.ceil((dateMs - Date.now()) / 1000);
  return seconds > 0 ? seconds : null;
}

function isRetryableError(err) {
  if (!err) {
    return false;
  }
  if (err.isRetryable) {
    return true;
  }
  const code = err.statusCode;
  return code === 408 || code === 429 || code === 500 || code === 502 || code === 503 || code === 504;
}

function getRetryDelayMs(err, attemptIndex) {
  const retryAfterSec = err && err.retryAfterSec;
  if (retryAfterSec && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000, LLM_MAX_RETRY_MS);
  }
  const exp = Math.min(attemptIndex - 1, 5);
  const base = LLM_BASE_RETRY_MS * Math.pow(2, exp);
  const jitter = Math.floor(Math.random() * 400);
  return Math.min(base + jitter, LLM_MAX_RETRY_MS);
}

function showSafeError(err, fallback) {
  const message = toErrorMessage(err, fallback);
  const uiMessage = compactMessage(message, 420);
  try {
    app.toast.error(uiMessage);
    app.dialogs.showInfoDialog(uiMessage);
  } catch (_ignore) {
    console.error("LLM Diagram Generator error:", message, err);
  }
}

function installGlobalErrorGuards() {
  try {
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("error", (event) => {
        const err = event && (event.error || event.message);
        console.error("Window error:", err);
      });

      window.addEventListener("unhandledrejection", (event) => {
        const reason = event && event.reason;
        console.error("Unhandled promise rejection:", reason);
        showSafeError(reason, "Unhandled promise rejection in extension.");
        if (event && typeof event.preventDefault === "function") {
          event.preventDefault();
        }
      });
    }
  } catch (err) {
    console.error("Failed to install window error guards:", err);
  }

  try {
    if (typeof process !== "undefined" && process.on) {
      process.on("unhandledRejection", (reason) => {
        console.error("UnhandledRejection:", reason);
        showSafeError(reason, "Unhandled promise rejection in extension.");
      });
      process.on("uncaughtException", (err) => {
        console.error("UncaughtException:", err);
        showSafeError(err, "Uncaught exception in extension.");
      });
    }
  } catch (err) {
    console.error("Failed to install process error guards:", err);
  }
}

function isDialogOk(result) {
  return !!result && result.buttonId === "ok";
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function viewCenter(view) {
  return {
    x: Math.round((view.left + view.getRight()) / 2),
    y: Math.round((view.top + view.getBottom()) / 2),
  };
}

function gridBox(index, cols, x0, y0, width, height, gapX, gapY) {
  const col = index % cols;
  const row = Math.floor(index / cols);
  const left = x0 + col * (width + gapX);
  const top = y0 + row * (height + gapY);
  return {
    x1: left,
    y1: top,
    x2: left + width,
    y2: top + height,
  };
}

function extractJson(text) {
  if (!text || typeof text !== "string") {
    throw new Error("LLM returned an empty response.");
  }

  let raw = text.trim();
  if (raw.startsWith("```") && raw.includes("```")) {
    raw = raw.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }

  try {
    return JSON.parse(raw);
  } catch (_ignore) {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(raw.substring(first, last + 1));
    }
    throw new Error("LLM output is not valid JSON.");
  }
}

function normalizeDiagramType(selectedType, spec) {
  if (selectedType !== "auto") {
    return selectedType;
  }
  const t = (spec.diagramType || "").toLowerCase();
  if (["class", "usecase", "sequence", "erd", "flowchart"].includes(t)) {
    return t;
  }
  return "class";
}

function buildPrompt(diagramType, description) {
  const typeInstruction =
    diagramType === "auto"
      ? "Choose the best diagramType from: class, usecase, sequence, erd, flowchart."
      : `Use diagramType exactly '${diagramType}'.`;

  return [
    "You are a strict diagram planner for StarUML.",
    typeInstruction,
    "Return JSON only, no markdown and no explanation.",
    "Use this JSON shape:",
    "{",
    "  \"diagramType\": \"class|usecase|sequence|erd|flowchart\",",
    "  \"name\": \"Diagram Name\",",
    "  \"classes\": [{ \"name\": \"A\", \"attributes\": [\"id: int\"], \"operations\": [\"save(): void\"] }],",
    "  \"relations\": [{ \"type\": \"association|generalization|dependency|realization|include|extend\", \"from\": \"A\", \"to\": \"B\", \"label\": \"optional\" }],",
    "  \"actors\": [{ \"name\": \"User\" }],",
    "  \"useCases\": [{ \"name\": \"Login\" }],",
    "  \"participants\": [{ \"name\": \"Client\" }],",
    "  \"messages\": [{ \"from\": \"Client\", \"to\": \"Server\", \"text\": \"request\", \"kind\": \"synchCall|asynchCall|reply\" }],",
    "  \"entities\": [{ \"name\": \"users\", \"columns\": [{ \"name\": \"id\", \"type\": \"int\", \"pk\": true, \"nullable\": false }] }],",
    "  \"relationships\": [{ \"from\": \"users\", \"to\": \"orders\", \"cardinalityFrom\": \"1\", \"cardinalityTo\": \"*\", \"name\": \"places\" }],",
    "  \"nodes\": [{ \"id\": \"start\", \"text\": \"Start\", \"type\": \"terminator|process|decision|data\" }],",
    "  \"flows\": [{ \"from\": \"start\", \"to\": \"check\", \"label\": \"optional\" }]",
    "}",
    "Only populate fields needed for the selected diagram type.",
    "User description:",
    description,
  ].join("\n");
}

async function callLLM(endpoint, model, apiKey, prompt) {
  const payload = JSON.stringify({
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: "You output strict JSON only." },
      { role: "user", content: prompt },
    ],
  });

  const data = await new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(endpoint);
    } catch (_ignore) {
      reject(new Error("Invalid endpoint URL."));
      return;
    }

    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const statusCode = res.statusCode;
          const apiMessage = extractApiErrorMessage(body);
          const retryAfter = res.headers && res.headers["retry-after"];
          const retryAfterSec = parseRetryAfterSeconds(retryAfter);

          if (statusCode === 429) {
            const retryText = retryAfter ? ` Retry after ${retryAfter} seconds.` : "";
            const err = new Error(
              `Rate limit or quota exceeded for the selected model.${retryText} ${apiMessage || "Check your quota/billing in provider dashboard."}`,
            );
            err.statusCode = statusCode;
            err.retryAfterSec = retryAfterSec;
            err.isRetryable = true;
            reject(err);
            return;
          }

          const err = new Error(
            `LLM request failed (${statusCode}): ${apiMessage || compactMessage(body, 220)}`,
          );
          err.statusCode = statusCode;
          err.retryAfterSec = retryAfterSec;
          err.isRetryable = statusCode === 408 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (_ignore) {
          reject(new Error("LLM response is not valid JSON."));
        }
      });
    });

    req.on("timeout", () => {
      const err = new Error("LLM request timed out.");
      err.isRetryable = true;
      req.destroy(err);
    });
    req.on("error", (e) => {
      const err = new Error(`Network error: ${toErrorMessage(e)}`);
      err.isRetryable = true;
      reject(err);
    });
    req.write(payload);
    req.end();
  });

  const content =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;

  return extractJson(content);
}

async function callLLMWithRetry(endpoint, model, apiKey, prompt) {
  let lastError = null;

  for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await callLLM(endpoint, model, apiKey, prompt);
    } catch (err) {
      lastError = err;
      const canRetry = attempt < LLM_MAX_ATTEMPTS && isRetryableError(err);
      if (!canRetry) {
        throw err;
      }

      const waitMs = getRetryDelayMs(err, attempt);
      app.toast.info(
        `LLM temporary error${err.statusCode ? ` (${err.statusCode})` : ""}. Retrying in ${Math.ceil(waitMs / 1000)}s... (${attempt}/${LLM_MAX_ATTEMPTS})`,
      );
      await sleep(waitMs);
    }
  }

  throw lastError || new Error("LLM request failed after retries.");
}

function addClassMembers(classModel, cls) {
  safeArray(cls.attributes).forEach((attrText) => {
    const raw = String(attrText || "").trim();
    if (!raw) {
      return;
    }
    app.factory.createModel({
      id: "UMLAttribute",
      parent: classModel,
      field: "attributes",
      modelInitializer: (m) => {
        m.name = raw;
      },
    });
  });

  safeArray(cls.operations).forEach((opText) => {
    const raw = String(opText || "").trim();
    if (!raw) {
      return;
    }
    app.factory.createModel({
      id: "UMLOperation",
      parent: classModel,
      field: "operations",
      modelInitializer: (m) => {
        m.name = raw;
      },
    });
  });
}

function createRelationship(diagram, id, parent, fromModel, toModel, label) {
  const tailView = diagram.getViewOf(fromModel);
  const headView = diagram.getViewOf(toModel);
  if (!tailView || !headView) {
    return null;
  }

  const tail = viewCenter(tailView);
  const head = viewCenter(headView);

  return app.factory.createModelAndView({
    id,
    parent,
    diagram,
    tailModel: fromModel,
    headModel: toModel,
    tailView,
    headView,
    x1: tail.x,
    y1: tail.y,
    x2: head.x,
    y2: head.y,
    modelInitializer: (m) => {
      if (label) {
        m.name = label;
      }
    },
  });
}

function generateClassDiagram(base, spec) {
  const diagram = app.factory.createDiagram({
    id: "UMLClassDiagram",
    parent: base,
    diagramInitializer: (d) => {
      d.name = spec.name || "Generated Class Diagram";
    },
  });

  const namespace = diagram._parent;
  const mapByName = {};
  const classes = safeArray(spec.classes);
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, classes.length))));

  classes.forEach((cls, i) => {
    const box = gridBox(i, cols, 80, 80, 170, 100, 80, 80);
    const view = app.factory.createModelAndView({
      id: "UMLClass",
      parent: namespace,
      diagram,
      x1: box.x1,
      y1: box.y1,
      x2: box.x2,
      y2: box.y2,
      modelInitializer: (m) => {
        m.name = cls.name || `Class${i + 1}`;
      },
    });
    if (view && view.model) {
      mapByName[view.model.name] = view.model;
      addClassMembers(view.model, cls);
    }
  });

  const relationTypeMap = {
    association: "UMLAssociation",
    generalization: "UMLGeneralization",
    dependency: "UMLDependency",
    realization: "UMLInterfaceRealization",
  };

  safeArray(spec.relations).forEach((rel) => {
    const from = mapByName[rel.from];
    const to = mapByName[rel.to];
    const id = relationTypeMap[(rel.type || "association").toLowerCase()] || "UMLAssociation";
    if (from && to) {
      createRelationship(diagram, id, from._parent || namespace, from, to, rel.label);
    }
  });

  return diagram;
}

function generateUseCaseDiagram(base, spec) {
  const diagram = app.factory.createDiagram({
    id: "UMLUseCaseDiagram",
    parent: base,
    diagramInitializer: (d) => {
      d.name = spec.name || "Generated Use Case Diagram";
    },
  });

  const namespace = diagram._parent;
  const mapByName = {};

  safeArray(spec.actors).forEach((actor, i) => {
    const box = gridBox(i, 2, 60, 80, 90, 160, 450, 60);
    const view = app.factory.createModelAndView({
      id: "UMLActor",
      parent: namespace,
      diagram,
      x1: box.x1,
      y1: box.y1,
      x2: box.x2,
      y2: box.y2,
      modelInitializer: (m) => {
        m.name = actor.name || `Actor${i + 1}`;
      },
    });
    if (view && view.model) {
      mapByName[view.model.name] = view.model;
    }
  });

  safeArray(spec.useCases).forEach((uc, i) => {
    const box = gridBox(i, 2, 260, 80, 180, 90, 130, 60);
    const view = app.factory.createModelAndView({
      id: "UMLUseCase",
      parent: namespace,
      diagram,
      x1: box.x1,
      y1: box.y1,
      x2: box.x2,
      y2: box.y2,
      modelInitializer: (m) => {
        m.name = uc.name || `UseCase${i + 1}`;
      },
    });
    if (view && view.model) {
      mapByName[view.model.name] = view.model;
    }
  });

  const relationTypeMap = {
    association: "UMLAssociation",
    include: "UMLInclude",
    extend: "UMLExtend",
    generalization: "UMLGeneralization",
  };

  safeArray(spec.relations).forEach((rel) => {
    const from = mapByName[rel.from];
    const to = mapByName[rel.to];
    const id = relationTypeMap[(rel.type || "association").toLowerCase()] || "UMLAssociation";
    if (from && to) {
      createRelationship(diagram, id, from._parent || namespace, from, to, rel.label);
    }
  });

  return diagram;
}

function generateSequenceDiagram(base, spec) {
  const diagram = app.factory.createDiagram({
    id: "UMLSequenceDiagram",
    parent: base,
    diagramInitializer: (d) => {
      d.name = spec.name || "Generated Sequence Diagram";
    },
  });

  const interaction = diagram._parent;
  const participantViews = {};
  const participants = safeArray(spec.participants);

  participants.forEach((p, i) => {
    const x = 120 + i * 170;
    const v = app.factory.createModelAndView({
      id: "UMLLifeline",
      parent: interaction,
      diagram,
      x1: x,
      y1: 100,
      x2: x,
      y2: 500,
      modelInitializer: (m) => {
        m.name = p.name || `Participant${i + 1}`;
      },
    });
    if (v && v.model) {
      participantViews[v.model.name] = v;
    }
  });

  const sortMap = {
    synchcall: "synchCall",
    asynchcall: "asynchCall",
    reply: "reply",
  };

  safeArray(spec.messages).forEach((msg, i) => {
    const tail = participantViews[msg.from];
    const head = participantViews[msg.to];
    if (!tail || !head) {
      return;
    }

    const tc = viewCenter(tail);
    const hc = viewCenter(head);
    const y = 140 + i * 45;
    const kind = sortMap[String(msg.kind || "synchCall").toLowerCase()] || "synchCall";

    app.factory.createModelAndView({
      id: "UMLMessage",
      parent: interaction,
      diagram,
      tailModel: tail.model,
      headModel: head.model,
      tailView: tail,
      headView: head,
      x1: tc.x,
      y1: y,
      x2: hc.x,
      y2: y,
      modelInitializer: (m) => {
        m.name = msg.text || `message${i + 1}`;
        m.messageSort = kind;
      },
    });
  });

  return diagram;
}

function generateErdDiagram(base, spec) {
  const diagram = app.factory.createDiagram({
    id: "ERDDiagram",
    parent: base,
    diagramInitializer: (d) => {
      d.name = spec.name || "Generated ER Diagram";
    },
  });

  const namespace = diagram._parent;
  const entities = safeArray(spec.entities);
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, entities.length))));
  const mapByName = {};

  entities.forEach((entity, i) => {
    const box = gridBox(i, cols, 80, 80, 220, 140, 80, 70);
    const view = app.factory.createModelAndView({
      id: "ERDEntity",
      parent: namespace,
      diagram,
      x1: box.x1,
      y1: box.y1,
      x2: box.x2,
      y2: box.y2,
      modelInitializer: (m) => {
        m.name = entity.name || `Entity${i + 1}`;
      },
    });

    if (view && view.model) {
      mapByName[view.model.name] = view.model;
      safeArray(entity.columns).forEach((col) => {
        app.factory.createModel({
          id: "ERDColumn",
          parent: view.model,
          field: "columns",
          modelInitializer: (m) => {
            m.name = col.name || "column";
            m.type = col.type || "";
            m.primaryKey = !!col.pk;
            m.nullable = !!col.nullable;
          },
        });
      });
    }
  });

  safeArray(spec.relationships).forEach((rel) => {
    const from = mapByName[rel.from];
    const to = mapByName[rel.to];
    if (!from || !to) {
      return;
    }
    createRelationship(diagram, "ERDRelationship", from._parent || namespace, from, to, rel.name);
    const model = app.repository
      .findAll((e) => e instanceof type.ERDRelationship)
      .find((r) => r.end1.reference === from && r.end2.reference === to);

    if (model) {
      app.engine.setProperty(model.end1, "cardinality", rel.cardinalityFrom || "1");
      app.engine.setProperty(model.end2, "cardinality", rel.cardinalityTo || "*");
    }
  });

  return diagram;
}

function flowchartNodeType(id) {
  const map = {
    process: "FCProcess",
    decision: "FCDecision",
    terminator: "FCTerminator",
    data: "FCData",
  };
  return map[String(id || "process").toLowerCase()] || "FCProcess";
}

function generateFlowchart(base, spec) {
  const diagram = app.factory.createDiagram({
    id: "FCFlowchartDiagram",
    parent: base,
    diagramInitializer: (d) => {
      d.name = spec.name || "Generated Flowchart";
    },
  });

  const namespace = diagram._parent;
  const mapById = {};
  const nodes = safeArray(spec.nodes);

  nodes.forEach((node, i) => {
    const box = gridBox(i, 3, 80, 80, 150, 90, 80, 60);
    const view = app.factory.createModelAndView({
      id: flowchartNodeType(node.type),
      parent: namespace,
      diagram,
      x1: box.x1,
      y1: box.y1,
      x2: box.x2,
      y2: box.y2,
      modelInitializer: (m) => {
        m.name = node.text || node.id || `Node${i + 1}`;
      },
    });
    if (view && view.model) {
      mapById[node.id || view.model.name] = view.model;
    }
  });

  safeArray(spec.flows).forEach((flow) => {
    const from = mapById[flow.from];
    const to = mapById[flow.to];
    if (from && to) {
      createRelationship(diagram, "FCFlow", from._parent || namespace, from, to, flow.label);
    }
  });

  return diagram;
}

function generateDiagram(base, selectedType, spec) {
  const resolvedType = normalizeDiagramType(selectedType, spec);

  switch (resolvedType) {
    case "class":
      return generateClassDiagram(base, spec);
    case "usecase":
      return generateUseCaseDiagram(base, spec);
    case "sequence":
      return generateSequenceDiagram(base, spec);
    case "erd":
      return generateErdDiagram(base, spec);
    case "flowchart":
      return generateFlowchart(base, spec);
    default:
      return generateClassDiagram(base, spec);
  }
}

async function handleConfigure() {
  try {
    const endpointCurrent = getPreference(PREF_ENDPOINT, DEFAULT_ENDPOINT);
    const modelCurrent = getPreference(PREF_MODEL, DEFAULT_MODEL);
    const keyCurrent = getPreference(PREF_API_KEY, "");

    const endpointResult = await app.dialogs.showInputDialog(
      "LLM API Endpoint",
      endpointCurrent,
    );
    if (!isDialogOk(endpointResult)) {
      return false;
    }

    const modelResult = await app.dialogs.showInputDialog(
      "Model Name",
      modelCurrent,
    );
    if (!isDialogOk(modelResult)) {
      return false;
    }

    const keyResult = await app.dialogs.showInputDialog(
      "API Key",
      keyCurrent,
    );
    if (!isDialogOk(keyResult)) {
      return false;
    }

    setPreference(
      PREF_ENDPOINT,
      String(endpointResult.returnValue || "").trim() || DEFAULT_ENDPOINT,
    );
    setPreference(
      PREF_MODEL,
      String(modelResult.returnValue || "").trim() || DEFAULT_MODEL,
    );
    setPreference(PREF_API_KEY, String(keyResult.returnValue || "").trim());

    app.toast.info("LLM Diagram Generator configuration saved.");
    return true;
  } catch (err) {
    showSafeError(err, "Failed to open configuration dialog.");
    return false;
  }
}

async function handleGenerate() {
  try {
    const base = app.selections.getSelected() || app.project.getProject();
    if (!base) {
      showSafeError("No open project found.");
      return;
    }

    const typeResult = await app.dialogs.showSelectRadioDialog(
      "Select diagram type",
      DIAGRAM_TYPES,
    );
    if (!isDialogOk(typeResult)) {
      return;
    }

    const descriptionResult = await app.dialogs.showTextDialog(
      "Describe the diagram to generate",
      "Describe entities, relationships, behaviors, and key details...",
    );
    if (!isDialogOk(descriptionResult)) {
      return;
    }

    const description = String(descriptionResult.returnValue || "").trim();
    if (!description) {
      showSafeError("Description is empty.");
      return;
    }

    let endpoint = getPreference(PREF_ENDPOINT, DEFAULT_ENDPOINT);
    let model = getPreference(PREF_MODEL, DEFAULT_MODEL);
    let apiKey = getPreference(PREF_API_KEY, "");

    if (!apiKey) {
      app.dialogs.showInfoDialog("Configure API key first.");
      await handleConfigure();
      endpoint = getPreference(PREF_ENDPOINT, DEFAULT_ENDPOINT);
      model = getPreference(PREF_MODEL, DEFAULT_MODEL);
      apiKey = getPreference(PREF_API_KEY, "");
      if (!apiKey) {
        return;
      }
    }

    app.toast.info("Generating diagram plan with LLM...");
    const prompt = buildPrompt(typeResult.returnValue, description);
    const spec = await callLLMWithRetry(endpoint, model, apiKey, prompt);
    const diagram = generateDiagram(base, typeResult.returnValue, spec);

    if (!diagram) {
      showSafeError("Failed to create diagram from LLM output.");
      return;
    }

    app.diagrams.openDiagram(diagram);
    app.diagrams.repaint();
    app.toast.info("Diagram generated successfully.");
  } catch (err) {
    showSafeError(err, "Diagram generation failed.");
  }
}

function handleConfigureCommand() {
  handleConfigure().catch((err) => {
    showSafeError(err, "Unexpected error while configuring extension.");
  });
}

function handleGenerateCommand() {
  handleGenerate().catch((err) => {
    showSafeError(err, "Unexpected error while generating diagram.");
  });
}

function init() {
  installGlobalErrorGuards();

  app.commands.register(
    "llm-diagram:configure",
    handleConfigureCommand,
    "LLM Diagram Generator: Configure",
  );
  app.commands.register(
    "llm-diagram:generate",
    handleGenerateCommand,
    "LLM Diagram Generator: Generate Diagram",
  );
}

exports.init = init;
