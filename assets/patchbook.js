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
 *    post content.
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
  function postPath(el) {
    return section(el).dataset.postPath;
  }
  function cve(el) {
    return section(el).dataset.cve || "post";
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
      // post body. It is rebuilt from the live response each time.
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
    var url = api(root) + "/api/votes?post=" + encodeURIComponent(postPath(root));
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
      .catch(function () {
        // Remember this so a click doesn't navigate to an unreachable login
        // endpoint, which surfaces as a browser "can't reach this page" with
        // nothing pointing at the real cause.
        root.dataset.offline = "1";
        setStatus(root, "Vote counts unavailable", true);
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

    if (root.dataset.offline) {
      setStatus(root, "Voting is unavailable right now — try reloading", true);
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
      ? fetch(url + "?post=" + encodeURIComponent(postPath(root)), {
          method: "DELETE",
          headers: authHeaders(),
        })
      : fetch(url, {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
          body: JSON.stringify({ post: postPath(root), verdict: verdict }),
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
        if (e.key === "Escape") group.classList.remove("is-open");
      });
    });

    document.addEventListener("click", function (e) {
      document.querySelectorAll(".vote-group.is-open").forEach(function (group) {
        if (!group.contains(e.target)) {
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
    var body = "Suggested change for `" + postPath(form) + "`:\n\n" + text + "\n";
    window.open(
      issueUrl(form, "suggestion", "[suggestion] " + cve(form), body),
      "_blank",
      "noopener"
    );
    lockForm(form);
    return false;
  }

  // Open GitHub's web editor for this post's source. GitHub auto-forks and
  // opens a PR on save for readers without write access.
  function editOnGitHub(link) {
    link.href =
      "https://github.com/" + repo(link) + "/edit/" + branch(link) + "/" + postPath(link);
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
