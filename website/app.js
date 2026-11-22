// Feature-detect native Popover API and load polyfill only when missing.
if (!Object.hasOwn(HTMLElement.prototype, "popover")) {
  import("https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js").catch(() => {});
}

/* ==========================================================================
   1. Responsive Single-<nav> Header & Floating Glass Scroll State
   ========================================================================== */

const header = document.getElementById("site-header");
const headerInner = header?.querySelector(".header-inner");
const siteMenu = document.getElementById("site-menu");

if (header && headerInner && siteMenu) {
  let lastHeaderWidth = 0;

  const updateNavLayout = () => {
    const isCurrentlyWide = header.classList.contains("is-wide");
    const currentWidth = header.clientWidth;

    if (!isCurrentlyWide && currentWidth <= lastHeaderWidth && lastHeaderWidth > 0) {
      return;
    }
    lastHeaderWidth = currentWidth;

    const wasPopoverOpen =
      siteMenu.hasAttribute("popover") &&
      (siteMenu.matches(":popover-open") || siteMenu.classList.contains(":popover-open"));

    header.classList.add("is-measuring");
    header.classList.add("is-wide");
    siteMenu.removeAttribute("popover");

    const fitsInline = headerInner.scrollWidth <= headerInner.clientWidth;

    if (!fitsInline) {
      header.classList.remove("is-wide");
      siteMenu.setAttribute("popover", "auto");
      if (wasPopoverOpen && typeof siteMenu.showPopover === "function") {
        try {
          siteMenu.showPopover();
        } catch {
          // Ignore if already open or unsupported
        }
      }
    }

    requestAnimationFrame(() => {
      header.classList.remove("is-measuring");
    });
  };

  const ro = new ResizeObserver(updateNavLayout);
  ro.observe(header);
  ro.observe(siteMenu);
  updateNavLayout();

  // Close mobile popover when clicking an in-page link
  siteMenu.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (link && siteMenu.hasAttribute("popover") && typeof siteMenu.hidePopover === "function") {
      try {
        siteMenu.hidePopover();
      } catch {
        // Ignore
      }
    }
  });

  const updateScrollState = () => {
    header.classList.toggle("is-scrolled", window.scrollY > 24);
  };
  window.addEventListener("scroll", updateScrollState, { passive: true });
  updateScrollState();
}

/* ==========================================================================
   2. Clipboard Helper with Accessible Live-Region Feedback
   ========================================================================== */

const copyStatus = document.getElementById("copy-status");

async function copyText(text, button) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    if (button) {
      const original = button.dataset.originalLabel || button.textContent.trim();
      button.dataset.originalLabel = original;
      button.textContent = "Copied!";
      clearTimeout(Number(button.dataset.resetTimer));
      const timer = setTimeout(() => {
        button.textContent = original;
      }, 1800);
      button.dataset.resetTimer = String(timer);
    }

    if (copyStatus) {
      copyStatus.textContent = "Copied to clipboard.";
      setTimeout(() => {
        copyStatus.textContent = "";
      }, 2000);
    }
  } catch {
    if (copyStatus) {
      copyStatus.textContent = "Copy failed. Please copy the text manually.";
    }
  }
}

document.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-copy-text], [data-copy-target]");
  if (!btn) return;

  let text = btn.getAttribute("data-copy-text");
  if (!text) {
    const targetId = btn.getAttribute("data-copy-target");
    const targetEl = targetId ? document.getElementById(targetId) : null;
    text = targetEl ? targetEl.textContent.trim() : "";
  }

  if (text) {
    copyText(text, btn);
  }
});

/* ==========================================================================
   3. Hero Quick Command Toggle
   ========================================================================== */

const heroCmdText = document.getElementById("hero-cmd-text");
document.querySelectorAll("[data-hero-cmd]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const cmd = btn.getAttribute("data-hero-cmd");
    if (heroCmdText && cmd) {
      heroCmdText.textContent = cmd;
    }
    document.querySelectorAll("[data-hero-cmd]").forEach((el) => {
      const active = el === btn;
      el.classList.toggle("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });
  });
});

/* ==========================================================================
   4. Prompt CMS Filter
   ========================================================================== */

const promptCards = Array.from(document.querySelectorAll("#prompt-list .prompt-card"));
document.querySelectorAll("[data-prompt-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const filter = btn.getAttribute("data-prompt-filter") || "all";
    document.querySelectorAll("[data-prompt-filter]").forEach((el) => {
      const active = el === btn;
      el.classList.toggle("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });

    promptCards.forEach((card) => {
      const cmsList = (card.getAttribute("data-cms") || "").split(/\s+/);
      card.hidden = filter !== "all" && !cmsList.includes(filter);
    });
  });
});

/* ==========================================================================
   5. Interactive CLI & Blueprint Builder
   ========================================================================== */

const builderForm = document.getElementById("builder-form");
const outCli = document.getElementById("out-cli");
const outPrompt = document.getElementById("out-prompt");
const outBlueprint = document.getElementById("out-blueprint");
const builderNote = document.getElementById("builder-note");
const portField = document.getElementById("port-field");
const cliArgsField = document.getElementById("cli-args-field");
const outputPathField = document.getElementById("output-path-field");

function generateBuilderOutput() {
  if (!builderForm || !outCli || !outPrompt || !outBlueprint) return;

  const data = new FormData(builderForm);
  const cms = String(data.get("cms") || "joomla");
  const command = String(data.get("command") || "start");
  const php = String(data.get("php") || "8.4");
  const cmsVersion = String(data.get("cmsVersion") || "").trim();
  const port = String(data.get("port") || "8790").trim();
  const cliArgs = String(data.get("cliArgs") || "user:list").trim();
  const outputPath = String(data.get("outputPath") || "./snapshot.zip").trim();
  const autoMount = builderForm.elements.autoMount?.checked ?? false;
  const useBlueprint = builderForm.elements.useBlueprint?.checked ?? false;
  const debugVerbosity = builderForm.elements.quiet?.checked ?? false;

  // Toggle contextual fields
  if (portField) portField.hidden = command !== "start";
  if (cliArgsField) cliArgsField.hidden = command !== "cli";
  if (outputPathField) outputPathField.hidden = command !== "build-snapshot";

  const cmsFlag = cms === "wp" ? "--wp" : "--joomla";
  const cmsWithVersion =
    cmsVersion && cmsVersion.toLowerCase() !== "latest" ? `${cmsFlag}=${cmsVersion}` : cmsFlag;
  const cmsName = cms === "wp" ? "WordPress" : "Joomla";

  const parts = ["npx cms-playground", command, cmsWithVersion];
  if (php && php !== "8.4") parts.push(`--php=${php}`);
  if (command === "start" && port && port !== "8790") parts.push(`--port=${port}`);
  if (command !== "cli" && autoMount) parts.push("--auto-mount");
  if (command === "run-blueprint" || (command !== "cli" && useBlueprint)) {
    parts.push("--blueprint=./blueprint.json");
  }
  if (command === "build-snapshot") {
    parts.push(`--output=${outputPath || "./snapshot.zip"}`);
  }
  if (debugVerbosity) parts.push("--verbosity=debug");
  if (command === "cli") {
    parts.push("--", cliArgs || "user:list");
  }

  const cliCommand = parts.join(" ");
  outCli.textContent = cliCommand;

  // Matching Agent Prompt
  let promptText = "";
  if (command === "start") {
    promptText = `Boot a disposable ${cmsName} sandbox on PHP ${php} by running \`${cliCommand}\`. Wait until the local server prints the Site URL, verify that the homepage returns HTTP 200 without PHP fatal errors, and report the URL and admin credentials.`;
  } else if (command === "run-blueprint") {
    promptText = `Create or update \`./blueprint.json\` for ${cmsName} (PHP ${php}), then execute it headlessly with \`${cliCommand}\`. Confirm every Blueprint step completes with exit code 0 and summarize the output.`;
  } else if (command === "build-snapshot") {
    promptText = `Run \`${cliCommand}\` to package a configured ${cmsName} site into \`${outputPath || "./snapshot.zip"}\`. Confirm the zip archive is created and report its file size.`;
  } else {
    promptText = `Run the native ${cmsName} CLI command inside PHP-WASM via \`${cliCommand}\` (no local PHP required) and summarize the command output.`;
  }
  outPrompt.textContent = promptText;

  // Matching Starter Blueprint JSON
  const blueprint =
    cms === "wp"
      ? {
          preferredVersions: {
            php,
            wp: cmsVersion || "latest",
          },
          landingPage: "/wp-admin/",
          steps: [
            {
              step: "defineWpConfigConsts",
              consts: { WP_DEBUG: true },
            },
            {
              step: "setSiteOption",
              option: "blogname",
              value: "Agent WordPress Sandbox",
            },
            {
              step: "runPHP",
              code: "file_put_contents('health.txt', 'ok');",
            },
          ],
        }
      : {
          preferredVersions: {
            php,
            joomla: cmsVersion || "latest",
          },
          landingPage: "/administrator/",
          steps: [
            {
              step: "setGlobalConfig",
              values: {
                sitename: "Agent Joomla Sandbox",
                debug: true,
              },
            },
            {
              step: "writeFile",
              path: "health.txt",
              data: "ok",
            },
            {
              step: "runSql",
              sql: "SELECT COUNT(*) FROM #__users;",
            },
          ],
        };

  outBlueprint.textContent = JSON.stringify(blueprint, null, 2);

  if (builderNote) {
    if (command === "cli" && cms === "wp") {
      builderNote.innerHTML =
        "Note: Native <code>cli</code> passthrough currently targets Joomla (<code>cli/joomla.php</code>). WP-CLI support is tracked in Phase 2 of the Roadmap.";
    } else if (command === "run-blueprint") {
      builderNote.innerHTML =
        "<code>run-blueprint</code> executes headlessly with no HTTP server—ideal for CI smoke tests and scripted agent verification.";
    } else {
      builderNote.innerHTML =
        "Tip: Use <code>--port=0</code> in CI or multi-agent runs to let the OS assign a free port automatically.";
    }
  }
}

if (builderForm) {
  builderForm.addEventListener("input", generateBuilderOutput);
  builderForm.addEventListener("change", generateBuilderOutput);
  generateBuilderOutput();
}

// Output Tabs (CLI Command / Agent Prompt / Blueprint JSON)
const outputTabs = Array.from(document.querySelectorAll("[data-output-tab]"));
outputTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const selected = tab.getAttribute("data-output-tab");
    outputTabs.forEach((el) => {
      const isActive = el === tab;
      el.classList.toggle("is-active", isActive);
      el.setAttribute("aria-selected", String(isActive));
      const panelId = el.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      if (panel) panel.hidden = !isActive;
    });
    if (selected) {
      generateBuilderOutput();
    }
  });
});

/* ==========================================================================
   6. Drop-in Agent Instructions (AGENTS.md / CLAUDE.md / Cursor / SKILL.md)
   ========================================================================== */

const AGENT_RULES = {
  agents: {
    filename: "AGENTS.md",
    content: `# Local CMS Verification with @cms-playground

Use \`@cms-playground\` to verify Joomla extensions and WordPress plugins/themes in a clean local PHP-WASM sandbox (Node.js 22+, no local PHP or MySQL required).

## Standard Workflows
- **Boot & auto-mount Joomla extension:**
  \`npx cms-playground start --joomla --auto-mount --port=0\`
- **Boot & auto-mount WordPress plugin/theme:**
  \`npx cms-playground start --wp --auto-mount --port=0\`
- **Run a headless Blueprint (CI / smoke tests):**
  \`npx cms-playground run-blueprint --joomla --blueprint=./blueprint.json --verbosity=debug\`
- **Export a portable snapshot:**
  \`npx cms-playground build-snapshot --wp --blueprint=./blueprint.json --output=./snapshot.zip\`
- **Run Joomla native CLI without local PHP:**
  \`npx cms-playground cli --joomla -- user:list\`

## Agent Rules
1. Always prefer \`--port=0\` or an explicit free port so parallel runs never collide.
2. Verify HTTP responses (status 200 and zero PHP fatal errors) before claiming a fix works.
3. Stop background \`cms-playground start\` processes when verification is complete.`,
  },
  claude: {
    filename: "CLAUDE.md",
    content: `# Claude Code — @cms-playground Guide

When testing Joomla or WordPress code in this repository, use \`npx cms-playground\` instead of asking the user to start Docker, MAMP, or local PHP.

## Commands
- Start Joomla with auto-mounted extension:
  \`npx cms-playground start --joomla --auto-mount --port=8790\`
- Start WordPress with auto-mounted plugin/theme:
  \`npx cms-playground start --wp --auto-mount --port=8791\`
- Headless Blueprint verification:
  \`npx cms-playground run-blueprint --wp --blueprint=./blueprint.json\`
- Joomla CLI commands:
  \`npx cms-playground cli --joomla -- cache:clean\`

## Verification Checklist
- Confirm \`--auto-mount\` detects the manifest/header cleanly.
- Fetch the printed local URL and inspect for PHP warnings or fatal errors.
- Tear down the server process after collecting evidence.`,
  },
  cursor: {
    filename: "cms-playground.mdc",
    content: `---
description: Use @cms-playground to boot disposable Joomla & WordPress PHP-WASM sandboxes for local testing
globs: ["**/*.php", "**/blueprint.json", "**/*.xml"]
alwaysApply: false
---

# @cms-playground Testing Rules

- Never assume local PHP, Apache, or MySQL is installed.
- Boot a disposable sandbox via \`npx cms-playground start --joomla --auto-mount\` or \`npx cms-playground start --wp --auto-mount\`.
- For non-interactive checks, write a \`blueprint.json\` with \`runPHP\` / \`runSql\` / \`setSiteOption\` steps and execute \`npx cms-playground run-blueprint\`.
- Use \`--verbosity=debug\` when diagnosing boot or mount failures.`,
  },
  skill: {
    filename: "SKILL.md",
    content: `---
name: cms-playground-testing
description: Boot disposable Joomla and WordPress instances in PHP-WASM using @cms-playground to test extensions, plugins, themes, and Blueprints locally.
---

# @cms-playground Testing Skill

## Quick Commands
- \`npx cms-playground list\` — inspect available CMS adapters and PHP versions
- \`npx cms-playground start --joomla --auto-mount\` — mount and discover a local Joomla extension
- \`npx cms-playground start --wp --auto-mount\` — mount and activate a local WordPress plugin or theme
- \`npx cms-playground run-blueprint --joomla --blueprint=./blueprint.json\` — headless verification
- \`npx cms-playground build-snapshot --wp --output=./snapshot.zip\` — export a configured site archive

## Guardrails
1. Read \`docs/BLUEPRINTS.md\` before authoring custom Blueprint steps.
2. Verify rendered pages or CLI exit codes before reporting success.
3. Shut down any background \`start\` process once testing finishes.`,
  },
};

const ruleFilenameEl = document.getElementById("rule-filename");
const ruleContentEl = document.getElementById("rule-content");
const downloadRuleBtn = document.getElementById("download-rule-btn");
let activeRuleKey = "agents";

function renderRule(key) {
  const entry = AGENT_RULES[key] || AGENT_RULES.agents;
  activeRuleKey = key;
  if (ruleFilenameEl) ruleFilenameEl.textContent = entry.filename;
  if (ruleContentEl) ruleContentEl.textContent = entry.content;
}

document.querySelectorAll("[data-rule-target]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.getAttribute("data-rule-target") || "agents";
    document.querySelectorAll("[data-rule-target]").forEach((el) => {
      const active = el === btn;
      el.classList.toggle("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });
    renderRule(key);
  });
});

if (downloadRuleBtn) {
  downloadRuleBtn.addEventListener("click", () => {
    const entry = AGENT_RULES[activeRuleKey] || AGENT_RULES.agents;
    const blob = new Blob([entry.content + "\n"], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = entry.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

renderRule("agents");
