// blocked.js
document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(location.search);
  const orig = params.get("orig");
  if (orig) {
    const el = document.getElementById("orig");
    const decodedUrl = decodeURIComponent(orig);
    const label = document.createElement("strong");
    label.textContent = "Attempted URL:";
    const link = document.createElement("a");
    link.className = "url";
    link.href = decodedUrl;
    link.textContent = decodedUrl;
    link.target = "_self";

    el.replaceChildren(label, document.createElement("br"), link);
  }

  function navigateToHome() {
    const homeUrl = (typeof chrome !== 'undefined' && chrome.runtime?.getURL) 
      ? chrome.runtime.getURL('homepage.html') 
      : 'homepage.html';
    window.location.href = homeUrl;
  }

  const goBackPreviousBtn = document.getElementById("goBackPrevious");
  if (goBackPreviousBtn) {
    goBackPreviousBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (window.history.length > 1) {
        window.history.back();
        // Fallback: If after 400ms still on the blocked page (e.g. no previous entry or redirect loop), go to home
        setTimeout(() => {
          navigateToHome();
        }, 400);
      } else {
        navigateToHome();
      }
    });
  }

  const goBackHomeBtn = document.getElementById("goBackHome");
  if (goBackHomeBtn) {
    goBackHomeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      navigateToHome();
    });
  }

  // Backwards compatibility for any legacy element
  const legacyGoBack = document.getElementById("goBack");
  if (legacyGoBack) {
    legacyGoBack.addEventListener("click", (e) => {
      e.preventDefault();
      navigateToHome();
    });
  }
});
