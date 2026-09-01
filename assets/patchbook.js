/* PatchBook — community votes and edit suggestions.
 *
 * Two different backends, on purpose:
 *
 *  - Votes talk to the Worker in worker/ (Cloudflare + D1). Counts and voter
 *    names are fetched live on every page load and updated optimistically on
 *    click, so a vote shows up immediately. Voting requires a GitHub login.
 *  - Edits stay on GitHub. "Edit on GitHub" opens the web editor, which forks
 *    and opens a pull request for non-collaborators; the change only appears on
 *    the site once that PR is merged and Pages rebuilds. Nothing here writes
 *    report content.
 */
window.PatchBook = (function () {
  var TOKEN_KEY = "pb_token";
  var VERDICTS = ["valid", "ai-slop"];

  function section(el) {
    return el.closest(".community");
  }
  function repo(el) {
    return section(el).dataset.repo;
  }
  function reportPath(el) {
    return section(el).dataset.reportPath;
  }
  function cve(el) {
    return section(el).dataset.cve || "report";
  }
  function branch(el) {
    return section(el).dataset.branch || "main";
  }
  function api(el) {
    return (section(el).dataset.api || "").replace(/\/+$/, "");
  }

  /* ── session ────────────────────────────────────────────────────────── */

  function token() {
    try {
      return window.localStorage.getItem(TOKEN_KEY) || "";
    } catch (e) {
      return ""; // private mode / storage disabled
    }
  }

  function setToken(value) {
    try {
      if (value) window.localStorage.setItem(TOKEN_KEY, value);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      /* nothing we can do; the reader just stays logged out */
    }
  }

  // The Worker hands the session back as `#pb_token=…` after OAuth. Pull it out
  // and scrub the fragment so it isn't left sitting in the address bar or
  // carried into a bookmark.
  function captureTokenFromHash() {
    var m = /[#&]pb_token=([^&]+)/.exec(window.location.hash || "");
    if (!m) return;
    setToken(decodeURIComponent(m[1]));
    var clean = window.location.hash.replace(/[#&]pb_token=[^&]*/, "");
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search + (clean === "#" ? "" : clean)
    );
  }

  function login(el) {
    var url = api(el) + "/auth/login?return=" + encodeURIComponent(window.location.href);
    window.location.href = url;
  }

  function authHeaders() {
    var t = token();
    return t ? { Authorization: "Bearer " + t } : {};
  }

  /* ── rendering ──────────────────────────────────────────────────────── */

  function bar(el) {
    return el.closest(".community-bar") || document.querySelector(".community-bar");
  }

  function render(root, state) {
    root.dataset.loaded = "1";
    var mine = state.you ? state.you.verdict : null;

    VERDICTS.forEach(function (verdict) {
      var group = root.querySelector('.vote-group[data-verdict="' + verdict + '"]');
      if (!group) return;

      var voters = (state.voters || []).filter(function (v) {
        return v.verdict === verdict;
      });

      group.querySelector(".vote-count").textContent = String(
        (state.counts && state.counts[verdict]) || 0
      );

      var btn = group.querySelector(".vote-btn");
      var isMine = mine === verdict;
      btn.classList.toggle("is-mine", isMine);
      btn.setAttribute("aria-pressed", isMine ? "true" : "false");
      btn.title = isMine
        ? "You voted " + verdict + " — click to retract"
        : "Vote " + verdict;

      // The voter list is deliberately *only* in this popover, never in the
      // report body. It is rebuilt from the live response each time.
      var list = group.querySelector(".voter-list");
      list.textContent = "";
      if (!voters.length) {
        var empty = document.createElement("li");
        empty.className = "muted small";
        empty.textContent = "No votes yet";
        list.appendChild(empty);
      }
      voters.forEach(function (v) {
        var li = document.createElement("li");
        var a = document.createElement("a");
        a.href = "https://github.com/" + encodeURIComponent(v.login);
        a.target = "_blank";
        a.rel = "noopener nofollow";
        a.textContent = v.login;
        li.appendChild(a);
        if (v.note) {
          var note = document.createElement("div");
          note.className = "community-note";
          note.textContent = v.note;
          li.appendChild(note);
        }
        list.appendChild(li);
      });
    });
  }

  function setStatus(root, message, isError) {
    var el = root.querySelector(".vote-status");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("is-error", !!isError);
  }

  /* ── vote actions ───────────────────────────────────────────────────── */

  function fetchVotes(root) {
    var url = api(root) + "/api/votes?report=" + encodeURIComponent(reportPath(root));
    return fetch(url, { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 401) {
          setToken(""); // expired session; fall back to anonymous read
          return fetch(url).then(function (r2) {
            return r2.json();
          });
        }
        return r.json();
      })
      .then(function (state) {
        delete root.dataset.offline;
        render(root, state);
        return state;
      })
      .catch(function (err) {
        // Remember this so a click doesn't navigate to an unreachable login
        // endpoint, which surfaces as a browser "can't reach this page" with
        // nothing pointing at the real cause.
        root.dataset.offline = "1";
        setStatus(root, "Vote counts unavailable", true);
        // fetch() cannot tell a CORS rejection from a dead host — both arrive
        // here as an opaque TypeError — so name both possibilities and print
        // the origin, which is the usual culprit (localhost vs 127.0.0.1 are
        // different origins and must both be in the Worker's allowlist).
        if (window.console) {
          console.warn(
            "PatchBook: vote API unreachable at " + api(root) +
              " — host down, or this origin (" + window.location.origin +
              ") is not in the Worker's ALLOWED_ORIGINS.",
            err
          );
        }
      });
  }

  // Predict the new counts locally so the number moves on click, then reconcile
  // with whatever the server actually stored.
  function optimistic(root, verdict, retracting) {
    var current = {};
    VERDICTS.forEach(function (v) {
      var n = parseInt(root.querySelector('.vote-group[data-verdict="' + v + '"] .vote-count').textContent, 10);
      current[v] = isNaN(n) ? 0 : n;
    });
    var mine = root.querySelector(".vote-btn.is-mine");
    var previous = mine ? mine.closest(".vote-group").dataset.verdict : null;
    if (previous) current[previous] = Math.max(0, current[previous] - 1);
    if (!retracting) current[verdict] = (current[verdict] || 0) + 1;

    VERDICTS.forEach(function (v) {
      var group = root.querySelector('.vote-group[data-verdict="' + v + '"]');
      group.querySelector(".vote-count").textContent = String(current[v]);
      var btn = group.querySelector(".vote-btn");
      var isMine = !retracting && v === verdict;
      btn.classList.toggle("is-mine", isMine);
      btn.setAttribute("aria-pressed", isMine ? "true" : "false");
    });
  }

  function vote(button) {
    var root = bar(button);
    var verdict = button.closest(".vote-group").dataset.verdict;

    // If the page loaded while the API was unreachable, don't refuse outright —
    // the failure may have been transient, and forcing a reload to recover from
    // one bad request would be worse than the dead-end this guard replaced.
    // Retry once, and carry on if the API is back.
    if (root.dataset.offline) {
      setStatus(root, "Retrying…");
      fetchVotes(root).then(function (state) {
        if (state && !root.dataset.offline) vote(button);
        else setStatus(root, "Voting is unavailable right now", true);
      });
      return false;
    }

    if (!token()) {
      login(root);
      return false;
    }

    // Clicking the verdict you already hold retracts it.
    var retracting = button.classList.contains("is-mine");
    optimistic(root, verdict, retracting);
    setStatus(root, "");

    var url = api(root) + "/api/vote";
    var request = retracting
      ? fetch(url + "?report=" + encodeURIComponent(reportPath(root)), {
          method: "DELETE",
          headers: authHeaders(),
        })
      : fetch(url, {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
          body: JSON.stringify({ report: reportPath(root), verdict: verdict }),
        });

    request
      .then(function (r) {
        if (r.status === 401) {
          setToken("");
          login(root);
          return null;
        }
        return r.json();
      })
      .then(function (state) {
        if (state && !state.error) render(root, state);
        else if (state) {
          setStatus(root, "Could not record your vote", true);
          fetchVotes(root);
        }
      })
      .catch(function () {
        setStatus(root, "Could not record your vote", true);
        fetchVotes(root); // roll the optimistic update back to server truth
      });

    return false;
  }

  /* ── voter popover ──────────────────────────────────────────────────── */

  // Hover shows the list, but hover alone would hide it from touch and keyboard
  // users, so the count is also a focusable button that toggles on click.
  function initPopovers() {
    document.querySelectorAll(".vote-group").forEach(function (group) {
      var count = group.querySelector(".vote-count");
      count.addEventListener("click", function () {
        var open = group.classList.toggle("is-open");
        count.setAttribute("aria-expanded", open ? "true" : "false");
      });
      count.addEventListener("keydown", function (e) {
        if (e.key !== "Escape") return;
        group.classList.remove("is-open");
        count.setAttribute("aria-expanded", "false");
        // Without blurring, :focus-visible still matches and Escape looks
        // like it did nothing.
        count.blur();
      });
    });

    document.addEventListener("click", function (e) {
      document.querySelectorAll(".vote-group.is-open").forEach(function (group) {
        // Casting a vote closes the list too: the buttons live inside the
        // group, so a containment check alone would keep it open.
        if (!group.contains(e.target) || e.target.closest(".vote-btn")) {
          group.classList.remove("is-open");
          group.querySelector(".vote-count").setAttribute("aria-expanded", "false");
        }
      });
    });
  }

  /* ── suggestions (unchanged: GitHub is the backend) ─────────────────── */

  function issueUrl(el, label, title, body) {
    return (
      "https://github.com/" +
      repo(el) +
      "/issues/new?labels=" +
      encodeURIComponent(label) +
      "&title=" +
      encodeURIComponent(title) +
      "&body=" +
      encodeURIComponent(body)
    );
  }

  function lockForm(el) {
    var box = el.closest(".community-form");
    if (!box || box.dataset.locked) return;
    box.dataset.locked = "1";
    box.querySelectorAll("textarea, input, button, a").forEach(function (c) {
      c.disabled = true;
      c.tabIndex = -1;
      c.setAttribute("aria-disabled", "true");
    });
    var ov = document.createElement("div");
    ov.className = "community-thanks";
    ov.setAttribute("role", "status");
    var strong = document.createElement("strong");
    strong.textContent = "Thanks for contributing!";
    var span = document.createElement("span");
    span.textContent = "We'll pick it up from GitHub.";
    ov.appendChild(strong);
    ov.appendChild(span);
    box.appendChild(ov);
  }

  // Read a named control via form.elements — NOT form.<name>, which collides
  // with built-in HTMLFormElement properties.
  function field(form, key) {
    var el = form.elements[key];
    return el && el.value ? el.value.trim() : "";
  }

  function submitSuggestion(form) {
    var text = field(form, "suggestion");
    if (!text) return false;
    var body = "Suggested change for `" + reportPath(form) + "`:\n\n" + text + "\n";
    window.open(
      issueUrl(form, "suggestion", "[suggestion] " + cve(form), body),
      "_blank",
      "noopener"
    );
    lockForm(form);
    return false;
  }

  // Open GitHub's web editor for this report's source. GitHub auto-forks and
  // opens a PR on save for readers without write access.
  function editOnGitHub(link) {
    link.href =
      "https://github.com/" + repo(link) + "/edit/" + branch(link) + "/" + reportPath(link);
    return true; // let the anchor navigate (target=_blank)
  }

  function initAccordion() {
    document.querySelectorAll(".community-actions").forEach(function (group) {
      var boxes = group.querySelectorAll(":scope > details.community-box");
      boxes.forEach(function (box) {
        box.addEventListener("toggle", function () {
          if (!box.open) return;
          boxes.forEach(function (other) {
            if (other !== box) other.open = false;
          });
        });
      });
    });
  }

  var started = false;

  function init() {
    if (started) return; // binding the popover toggles twice would cancel them out
    started = true;
    captureTokenFromHash();
    initAccordion();
    initPopovers();
    var root = document.querySelector(".community-bar[data-api]");
    if (root && api(root)) fetchVotes(root);
  }

  // Run now if the document is already parsed — waiting on DOMContentLoaded
  // alone would never fire if this script is loaded async/deferred.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return {
    vote: vote,
    submitSuggestion: submitSuggestion,
    editOnGitHub: editOnGitHub,
  };
})();

/* PatchBook — report list filtering and the severity plot.
 *
 * Separate IIFE from the vote UI above: it runs on the Windows list page, the
 * vote UI runs on a report page, and neither needs the other. No dependencies —
 * the slider is two native range inputs and the chart is hand-built SVG.
 */
window.PatchBookReports = (function () {
  var SVG_NS = "http://www.w3.org/2000/svg";
  var VIEW_W = 960, VIEW_H = 220;
  var PAD = { top: 14, right: 16, bottom: 28, left: 34 };
  var DAY = 86400000;

  function el(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    for (var k in attrs) if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    return node;
  }

  // "2026-08-29" → UTC midnight. Deliberately not `new Date(str)` for the
  // whole value: local-timezone parsing shifts a date by a day either side of
  // UTC, which visibly moves dots and silently changes filter results.
  function parseDay(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  }

  function toISO(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  function readCards(root) {
    return [].slice.call(root.querySelectorAll(".report-card")).map(function (card) {
      var cvss = card.dataset.cvss ? parseFloat(card.dataset.cvss) : null;
      return {
        card: card,
        day: parseDay(card.dataset.date),
        cvss: isNaN(cvss) ? null : cvss,
        title: card.dataset.title || "",
        href: card.getAttribute("href"),
      };
    }).filter(function (r) { return !isNaN(r.day); });
  }

  /* ── chart ──────────────────────────────────────────────────────────── */

  function drawChart(figure, rows, from, to) {
    var svg = figure.querySelector("[data-chart-svg]");
    var note = figure.querySelector("[data-chart-note]");
    var tip = figure.querySelector("[data-chart-tip]");
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    var scored = rows.filter(function (r) { return r.cvss !== null; });
    var missing = rows.length - scored.length;

    // Nothing to place on a severity axis — say so rather than drawing an
    // empty grid that looks like a rendering failure.
    if (!scored.length) {
      figure.hidden = true;
      return;
    }
    figure.hidden = false;

    var x0 = PAD.left, x1 = VIEW_W - PAD.right;
    var y0 = PAD.top, y1 = VIEW_H - PAD.bottom;
    // A single report, or several on one day, would give a zero-width domain
    // and put every dot on the left edge; pad it so they centre instead.
    var span = to - from;
    if (span <= 0) { from -= DAY; to += DAY; span = to - from; }

    var xOf = function (day) { return x0 + ((day - from) / span) * (x1 - x0); };
    var yOf = function (cvss) { return y1 - (cvss / 10) * (y1 - y0); };

    // recessive hairline grid + severity ticks
    [0, 2.5, 5, 7.5, 10].forEach(function (v) {
      var y = yOf(v);
      svg.appendChild(el("line", { x1: x0, y1: y, x2: x1, y2: y, class: "chart-grid" }));
      var label = el("text", { x: x0 - 8, y: y + 4, "text-anchor": "end", class: "chart-axis-text" });
      label.textContent = String(v);
      svg.appendChild(label);
    });

    [from, to].forEach(function (day, i) {
      var label = el("text", {
        x: i === 0 ? x0 : x1, y: VIEW_H - 8,
        "text-anchor": i === 0 ? "start" : "end", class: "chart-axis-text",
      });
      label.textContent = toISO(day);
      svg.appendChild(label);
    });

    scored.forEach(function (r) {
      var cx = xOf(r.day), cy = yOf(r.cvss);
      // A real anchor: clicking opens the report and it is keyboard-reachable
      // with no JS at all.
      var a = el("a", { class: "chart-point", href: r.href, tabindex: "0" });
      a.setAttribute("aria-label", r.title + ", CVSS " + r.cvss + ", " + toISO(r.day));
      // Transparent hit circle first, so the target is ~24px rather than the
      // 8px painted dot.
      a.appendChild(el("circle", { cx: cx, cy: cy, r: 12, class: "chart-hit" }));
      a.appendChild(el("circle", { cx: cx, cy: cy, r: 5, class: "chart-dot" }));

      function show() {
        tip.textContent = "";
        var key = document.createElement("span");
        key.className = "chart-tip-key";
        var value = document.createElement("span");
        value.className = "chart-tip-value";
        value.textContent = "CVSS " + r.cvss;           // value leads
        var label = document.createElement("span");
        label.className = "chart-tip-label";
        label.textContent = " · " + r.title + " · " + toISO(r.day);
        tip.appendChild(key);
        tip.appendChild(value);
        tip.appendChild(label);                          // textContent, never innerHTML
        tip.hidden = false;
        tip.style.left = (cx / VIEW_W * 100) + "%";
        tip.style.top = (cy / VIEW_H * 100) + "%";
      }
      function hide() { tip.hidden = true; }

      a.addEventListener("mouseenter", show);
      a.addEventListener("mouseleave", hide);
      a.addEventListener("focus", show);   // same detail on keyboard focus
      a.addEventListener("blur", hide);
      svg.appendChild(a);
    });

    note.textContent = missing
      ? scored.length + " scored · " + missing + " without a CVSS score, not plotted"
      : scored.length + " report" + (scored.length === 1 ? "" : "s") + " in range";
  }

  /* ── filtering ──────────────────────────────────────────────────────── */

  // The range opens on the current year rather than on the data's own extent:
  // "everything published this year, up to today" is the question a reader
  // actually arrives with.
  var DEFAULT_START = Date.UTC(2026, 0, 1);

  function todayUTC() {
    var n = new Date();
    return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  }

  function init() {
    var filter = document.querySelector("[data-report-filter]");
    var list = document.querySelector("[data-report-list]");
    if (!filter || !list) return;

    var rows = readCards(list);
    if (!rows.length) return;

    var figure = document.querySelector("[data-severity-chart]");
    var empty = document.querySelector("[data-filter-empty]");
    var summary = filter.querySelector("[data-filter-summary]");
    var fromInput = filter.querySelector("[data-filter-from]");
    var toInput = filter.querySelector("[data-filter-to]");
    var track = filter.querySelector("[data-range-track]");
    var fill = filter.querySelector("[data-range-fill]");
    var handleFrom = filter.querySelector('[data-range-handle="from"]');
    var handleTo = filter.querySelector('[data-range-handle="to"]');
    var reset = filter.querySelector("[data-filter-reset]");
    var endMin = filter.querySelector("[data-range-min]");
    var endMax = filter.querySelector("[data-range-max]");

    var days = rows.map(function (r) { return r.day; });
    // The domain has to cover both the default window and anything published
    // outside it, or a report would exist that the slider cannot reach.
    var minDay = Math.min.apply(null, days.concat([DEFAULT_START]));
    var maxDay = Math.max.apply(null, days.concat([todayUTC()]));

    var from = Math.max(DEFAULT_START, minDay);
    var to = Math.min(todayUTC(), maxDay);
    if (to < from) { from = minDay; to = maxDay; }

    [fromInput, toInput].forEach(function (input) {
      input.min = toISO(minDay);
      input.max = toISO(maxDay);
    });
    if (endMin) endMin.textContent = toISO(minDay);
    if (endMax) endMax.textContent = toISO(maxDay);

    var span = Math.max(1, maxDay - minDay);
    var ratio = function (day) { return (day - minDay) / span; };
    var dayAt = function (fraction) {
      return minDay + Math.round((fraction * span) / DAY) * DAY;
    };

    function apply() {
      var shown = 0;
      rows.forEach(function (r) {
        var visible = r.day >= from && r.day <= to;
        r.card.hidden = !visible;
        if (visible) shown++;
      });

      fromInput.value = toISO(from);
      toInput.value = toISO(to);

      var a = ratio(from) * 100, b = ratio(to) * 100;
      handleFrom.style.left = a + "%";
      handleTo.style.left = b + "%";
      fill.style.left = a + "%";
      fill.style.width = Math.max(0, b - a) + "%";

      [[handleFrom, from], [handleTo, to]].forEach(function (pair) {
        pair[0].setAttribute("aria-valuemin", toISO(minDay));
        pair[0].setAttribute("aria-valuemax", toISO(maxDay));
        pair[0].setAttribute("aria-valuenow", toISO(pair[1]));
        pair[0].setAttribute("aria-valuetext", toISO(pair[1]));
      });

      summary.textContent = shown === rows.length
        ? shown + " report" + (shown === 1 ? "" : "s")
        : shown + " of " + rows.length + " reports";

      if (empty) empty.hidden = shown !== 0;
      // The plot always reflects the current range — same call site as the list.
      drawChart(figure, rows.filter(function (r) { return !r.card.hidden; }), from, to);
    }

    function setFrom(day) { from = Math.min(Math.max(day, minDay), to); apply(); }
    function setTo(day)   { to   = Math.max(Math.min(day, maxDay), from); apply(); }

    /* dragging ------------------------------------------------------------ */

    function dayFromClientX(clientX) {
      var box = track.getBoundingClientRect();
      if (!box.width) return null;
      var fraction = (clientX - box.left) / box.width;
      return dayAt(Math.min(1, Math.max(0, fraction)));
    }

    function drag(handle, setter) {
      handle.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);   // keep tracking outside the track
        handle.classList.add("is-dragging");
      });
      handle.addEventListener("pointermove", function (e) {
        if (!handle.hasPointerCapture(e.pointerId)) return;
        var day = dayFromClientX(e.clientX);
        if (day !== null) setter(day);
      });
      ["pointerup", "pointercancel"].forEach(function (type) {
        handle.addEventListener(type, function (e) {
          handle.classList.remove("is-dragging");
          if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        });
      });
    }
    drag(handleFrom, setFrom);
    drag(handleTo, setTo);

    // Clicking the line jumps whichever end is nearer, so the whole track is
    // usable and not just the two 16px circles.
    track.addEventListener("pointerdown", function (e) {
      var day = dayFromClientX(e.clientX);
      if (day === null) return;
      if (Math.abs(day - from) <= Math.abs(day - to)) setFrom(day); else setTo(day);
    });

    /* keyboard ------------------------------------------------------------ */

    function keys(handle, get, setter) {
      handle.addEventListener("keydown", function (e) {
        var step = e.shiftKey ? 7 : 1;
        var day = get();
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") day -= step * DAY;
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") day += step * DAY;
        else if (e.key === "PageDown") day -= 30 * DAY;
        else if (e.key === "PageUp") day += 30 * DAY;
        else if (e.key === "Home") day = minDay;
        else if (e.key === "End") day = maxDay;
        else return;
        e.preventDefault();
        setter(day);
      });
    }
    keys(handleFrom, function () { return from; }, setFrom);
    keys(handleTo, function () { return to; }, setTo);

    /* typed dates stay available as the precise, accessible fallback ------- */

    fromInput.addEventListener("change", function () {
      var d = parseDay(fromInput.value);
      if (!isNaN(d)) setFrom(d); else apply();   // reject junk, restore the field
    });
    toInput.addEventListener("change", function () {
      var d = parseDay(toInput.value);
      if (!isNaN(d)) setTo(d); else apply();
    });

    reset.addEventListener("click", function () {
      from = Math.max(DEFAULT_START, minDay);
      to = Math.min(todayUTC(), maxDay);
      apply();
    });

    apply();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { init: init };
})();
