document.addEventListener('DOMContentLoaded', () => {
    const ul = document.getElementById('whitelist-ul');
    const iframe = document.getElementById('quiz-iframe');
    const classSelect = document.getElementById('homepage-class-select');
    const classCodeInput = document.getElementById('homepage-class-code-input');
    const admissionInput = document.getElementById('homepage-admission-input');
    const guardianPhoneInput = document.getElementById('homepage-guardian-phone-input');

    // Helper to update iframe URL
    function updateIframeSrc(info) {
        if (iframe) {
            let baseSrc = iframe.getAttribute('data-src');
            if (baseSrc) {
                let params = new URLSearchParams();
                if (info) {
                    if (info.rollNumber) params.append('roll', info.rollNumber);
                    const gradeVal = info.grade || info.classCode;
                    if (gradeVal) params.append('grade', gradeVal);
                    if (info.admissionNumber) params.append('admission', info.admissionNumber);
                    if (info.guardianPhone) params.append('phone', info.guardianPhone);
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

    // Function to save student info to storage
    function saveStudentInfo(updates) {
        if (!chrome || !chrome.storage) {
            updateIframeSrc(updates);
            return;
        }
        chrome.storage.local.get(['studentInfo'], (result) => {
            const currentInfo = result.studentInfo || {};
            Object.assign(currentInfo, updates);
            chrome.storage.local.set({ studentInfo: currentInfo }, () => {
                updateIframeSrc(currentInfo);
                // If classCode changed, we need to refresh wishlist and reload
                if (updates.classCode !== undefined) {
                    chrome.runtime.sendMessage({ type: 'refreshWishlist', classCode: updates.classCode }, () => {
                        window.location.reload();
                    });
                }
            });
        });
    }

    // Always attach the event listener so it works even when testing locally
    if (classSelect) {
        classSelect.addEventListener('change', (e) => saveStudentInfo({ grade: e.target.value }));
    }
    
    if (admissionInput) {
        admissionInput.addEventListener('blur', (e) => saveStudentInfo({ admissionNumber: e.target.value.trim() }));
    }
    
    if (guardianPhoneInput) {
        guardianPhoneInput.addEventListener('blur', (e) => saveStudentInfo({ guardianPhone: e.target.value.trim() }));
    }

    if (classCodeInput) {
        classCodeInput.addEventListener('change', async (e) => {
            const code = e.target.value.trim();
            if (!code) return;
            
            try {
                const refreshResponse = await chrome.runtime.sendMessage({ type: 'refreshWishlist', classCode: code });
                if (!refreshResponse?.success) {
                    alert(refreshResponse?.message || 'Class code was not found in Firestore.');
                    // Revert input value to cached class code
                    chrome.storage.local.get(['studentInfo'], (res) => {
                        classCodeInput.value = res.studentInfo?.classCode || '';
                    });
                    return;
                }
                
                // Save to local storage
                chrome.storage.local.get(['studentInfo'], (res) => {
                    const currentInfo = res.studentInfo || {};
                    currentInfo.classCode = code;
                    currentInfo.className = refreshResponse.className || '';
                    chrome.storage.local.set({ studentInfo: currentInfo }, () => {
                        window.location.reload();
                    });
                });
            } catch (err) {
                console.error("Error updating class code from homepage:", err);
            }
        });
    }

    // Fullscreen logic for the quiz
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    if (fullscreenBtn && iframe) {
        fullscreenBtn.addEventListener('click', () => {
            if (iframe.requestFullscreen) {
                iframe.requestFullscreen();
            } else if (iframe.webkitRequestFullscreen) { /* Safari */
                iframe.webkitRequestFullscreen();
            } else if (iframe.msRequestFullscreen) { /* IE11 */
                iframe.msRequestFullscreen();
            }
        });
    }

    if (!chrome || !chrome.storage) {
        if (ul) ul.innerHTML = '<li>Error: Cannot access extension storage.</li>';
        updateIframeSrc(null); // Ensure iframe loads even when testing locally
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

        if (ul) {
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
        }

        // Display student badge if configured
        const infoEl = document.getElementById('homepage-student-info');
        const infoContainer = document.getElementById('homepage-student-info-container');
        if (infoEl && infoContainer && result.studentInfo && result.studentInfo.classCode) {
            const displayClass = result.studentInfo.className || result.studentInfo.classCode;
            infoEl.textContent = `Class: ${displayClass}`;
            infoContainer.style.display = 'flex';
        } else if (infoContainer) {
            infoContainer.style.display = 'none';
        }

        // Initialize and update iframe
        if (classSelect && result.studentInfo && result.studentInfo.grade) {
            classSelect.value = result.studentInfo.grade;
        }
        if (classCodeInput && result.studentInfo && result.studentInfo.classCode) {
            classCodeInput.value = result.studentInfo.classCode;
        }
        if (admissionInput && result.studentInfo && result.studentInfo.admissionNumber) {
            admissionInput.value = result.studentInfo.admissionNumber;
        }
        if (guardianPhoneInput && result.studentInfo && result.studentInfo.guardianPhone) {
            guardianPhoneInput.value = result.studentInfo.guardianPhone;
        }
        updateIframeSrc(result.studentInfo);
    });

});
