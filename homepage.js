document.addEventListener('DOMContentLoaded', () => {
    const ul = document.getElementById('whitelist-ul');
    if (!chrome || !chrome.storage) {
        ul.innerHTML = '<li>Error: Cannot access extension storage.</li>';
        return;
    }

    chrome.storage.local.get(['whitelist', 'classWishlistCache', 'studentInfo'], (result) => {
        let combined = [...(result.whitelist || [])];

        // Add class wishlist if available
        if (result.classWishlistCache && Array.isArray(result.classWishlistCache.wishlist)) {
            combined = [...combined, ...result.classWishlistCache.wishlist];
        }

        // Add REQUIRED_RULES from config.js
        if (window.CONFIG && Array.isArray(window.CONFIG.REQUIRED_RULES)) {
            combined = [...combined, ...window.CONFIG.REQUIRED_RULES];
        }

        // Remove duplicates and filter empty
        let finalWhitelist = Array.from(new Set(combined)).filter(url => url.trim() !== '');

        // Filter out extension URLs and browser internal URLs for better display
        finalWhitelist = finalWhitelist.filter(url =>
            !url.startsWith('chrome-extension://') &&
            !url.startsWith('chrome://') &&
            !url.startsWith('edge://')
        );

        if (finalWhitelist.length === 0) {
            ul.innerHTML = '<li>No whitelisted websites found.</li>';
        } else {
            finalWhitelist.sort();
            ul.innerHTML = finalWhitelist.map(url => {
                // Convert rule to valid href
                let href = url;
                if (!/^https?:\/\//i.test(href)) {
                    href = 'https://' + href.replace(/^\*\./, '').replace(/\/+$/, '');
                }

                let domain = href;
                try {
                    domain = new URL(href).hostname;
                } catch (e) { }

                const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

                return `<li>
                    <img src="${faviconUrl}" alt="" width="48" height="48" style="border-radius: 6px; flex-shrink: 0;">
                    <a href="${href}" target="_blank" style="color: inherit; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${url}</a>
                </li>`;
            }).join('');
        }

        // Helper to update iframe URL
        function updateIframeSrc(info) {
            const iframe = document.getElementById('quiz-iframe');
            if (iframe) {
                let baseSrc = iframe.getAttribute('data-src');
                if (baseSrc) {
                    let params = new URLSearchParams();
                    if (info) {
                        if (info.rollNumber) params.append('roll', info.rollNumber);
                        if (info.classCode) params.append('grade', info.classCode);
                    }
                    const queryString = params.toString();
                    if (queryString) {
                        const sep = baseSrc.includes('?') ? '&' : '?';
                        iframe.src = `${baseSrc}${sep}${queryString}`;
                    } else {
                        iframe.src = baseSrc;
                    }
                }
            }
        }

        // Initialize and update iframe
        const classSelect = document.getElementById('homepage-class-select');
        if (classSelect && result.studentInfo && result.studentInfo.classCode) {
            classSelect.value = result.studentInfo.classCode;
        }
        updateIframeSrc(result.studentInfo);

        // Handle class dropdown change
        if (classSelect) {
            classSelect.addEventListener('change', (e) => {
                const newClassCode = e.target.value;
                const currentInfo = result.studentInfo || {};
                currentInfo.classCode = newClassCode;
                chrome.storage.local.set({ studentInfo: currentInfo }, () => {
                    updateIframeSrc(currentInfo);
                    // Refresh whitelist in background and reload page to reflect changes
                    chrome.runtime.sendMessage({ type: 'refreshWishlist', classCode: newClassCode }, () => {
                        window.location.reload();
                    });
                });
            });
        }
    });

    // Fullscreen logic for the quiz
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const quizIframe = document.getElementById('quiz-iframe');
    if (fullscreenBtn && quizIframe) {
        fullscreenBtn.addEventListener('click', () => {
            if (quizIframe.requestFullscreen) {
                quizIframe.requestFullscreen();
            } else if (quizIframe.webkitRequestFullscreen) { /* Safari */
                quizIframe.webkitRequestFullscreen();
            } else if (quizIframe.msRequestFullscreen) { /* IE11 */
                quizIframe.msRequestFullscreen();
            }
        });
    }
});
