document.addEventListener('DOMContentLoaded', () => {
    const ul = document.getElementById('whitelist-ul');
    if (!chrome || !chrome.storage) {
        ul.innerHTML = '<li>Error: Cannot access extension storage.</li>';
        return;
    }

    chrome.storage.local.get(['whitelist', 'classWishlistCache'], (result) => {
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
            // Sort alphabetically
            finalWhitelist.sort();
            ul.innerHTML = finalWhitelist.map(url => {
                // Convert rule to valid href
                let href = url;
                if (!/^https?:\/\//i.test(href)) {
                    href = 'https://' + href.replace(/^\*\./, '').replace(/\/+$/, '');
                }
                return `<li><a href="${href}" target="_blank" style="color: inherit; text-decoration: none;">${url}</a></li>`;
            }).join('');
        }
    });
});
