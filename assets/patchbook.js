/* PatchBook — community validation & suggestion submitters.
 *
 * Everything here is pure client-side. We never POST anywhere; we only build
 * prefilled GitHub URLs and open them in a new tab. The "backend" is GitHub:
 *  - validation / suggestion issues are parsed by .github/workflows (validations
 *    are auto-committed into the post's frontmatter by scripts/apply_validation.py);
 *  - "Edit on GitHub" opens the web editor, which forks + opens a PR for
 *    non-collaborators.
 */
window.PatchBook = (function () {
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

  // Build a GitHub "new issue" URL with prefilled title/body/labels.
  function issueUrl(el, label, title, body) {
    var base = "https://github.com/" + repo(el) + "/issues/new";
    var q =
      "?labels=" +
      encodeURIComponent(label) +
      "&title=" +
      encodeURIComponent(title) +
      "&body=" +
      encodeURIComponent(body);
    return base + q;
  }

  // Read a named control via form.elements — NOT form.<name>, which collides
  // with built-in HTMLFormElement properties (e.g. form.name is the form's own
  // name attribute, not the input named "name").
  function field(form, key) {
    var el = form.elements[key];
    return el && el.value ? el.value.trim() : "";
  }

  function submitValidation(form) {
    var el = form;
    var verdict = field(form, "verdict");
    var name = field(form, "name");
    var contact = field(form, "contact");
    var note = field(form, "note");
    if (!verdict || !name || !contact) return false;

    // Structured yaml block parsed by scripts/apply_validation.py.
    var body =
      "Submitted from PatchBook. A maintainer action will record this mark on the post.\n\n" +
      "```yaml\n" +
      "type: validation\n" +
      "post: " +
      postPath(el) +
      "\n" +
      "verdict: " +
      verdict +
      "\n" +
      "name: " +
      name +
      "\n" +
      "contact: " +
      contact +
      "\n" +
      (note ? "note: " + note.replace(/\r?\n/g, " ") + "\n" : "") +
      "```\n";

    var title = "[validation] " + cve(el) + " — " + verdict;
    window.open(issueUrl(el, "validation", title, body), "_blank", "noopener");
    return false;
  }

  function submitSuggestion(form) {
    var el = form;
    var text = field(form, "suggestion");
    if (!text) return false;
    var body =
      "Suggested change for `" +
      postPath(el) +
      "`:\n\n" +
      text +
      "\n";
    var title = "[suggestion] " + cve(el);
    window.open(issueUrl(el, "suggestion", title, body), "_blank", "noopener");
    return false;
  }

  // Open GitHub's web editor for this post's source file. GitHub auto-forks
  // and creates a PR on save for users without write access.
  function editOnGitHub(link) {
    var el = link;
    link.href =
      "https://github.com/" +
      repo(el) +
      "/edit/" +
      branch(el) +
      "/" +
      postPath(el);
    return true; // let the anchor navigate (target=_blank)
  }

  return {
    submitValidation: submitValidation,
    submitSuggestion: submitSuggestion,
    editOnGitHub: editOnGitHub,
  };
})();
