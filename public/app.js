// Use current origin for Electron compatibility (dynamic port)
// In web mode, this will be http://localhost:4500
// In Electron, this will be the random port Electron assigned
const API_BASE = `${window.location.origin}/api`;

let currentRepoId = null;
let currentFiles = [];
let currentFile = null;
let currentDiffLines = [];
let comments = [];

// Auto-save comments to backend
async function saveCommentsToBackend() {
  if (!currentRepoId) return;

  try {
    await fetch(`${API_BASE}/save-comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoId: currentRepoId,
        comments: comments // Send empty array if no comments
      })
    });
  } catch (error) {
    console.error('Failed to save comments:', error);
  }
}

// Load comments from backend
async function loadCommentsFromBackend() {
  if (!currentRepoId) return [];

  try {
    const response = await fetch(`${API_BASE}/load-comments/${currentRepoId}`);
    const data = await response.json();
    return data.comments || [];
  } catch (error) {
    console.error('Failed to load comments:', error);
    return [];
  }
}

// Fuzzy match saved comments to current diff
function matchCommentsToDiff(savedComments, filePath, diffLines) {
  const fileComments = savedComments.filter(c => c.file === filePath);
  const matched = [];

  fileComments.forEach(savedComment => {
    let matchResult = null;

    // Try exact match first (line number + content)
    const exactMatch = diffLines.findIndex(dl =>
      (dl.newLine === savedComment.line || dl.oldLine === savedComment.line) &&
      dl.content === savedComment.lineContent
    );

    if (exactMatch !== -1) {
      matchResult = {
        ...savedComment,
        diffLineIndex: exactMatch,
        matchType: 'exact'
      };
    } else {
      // Try fuzzy match (search ±5 lines for similar content)
      let bestMatch = -1;
      let bestSimilarity = 0;

      for (let i = 0; i < diffLines.length; i++) {
        const dl = diffLines[i];
        const lineNum = dl.newLine || dl.oldLine;

        // Check if within ±5 lines
        if (Math.abs(lineNum - savedComment.line) <= 5) {
          const similarity = calculateSimilarity(dl.content, savedComment.lineContent);
          if (similarity > bestSimilarity && similarity > 0.6) {
            bestSimilarity = similarity;
            bestMatch = i;
          }
        }
      }

      if (bestMatch !== -1) {
        matchResult = {
          ...savedComment,
          diffLineIndex: bestMatch,
          matchType: 'fuzzy',
          newLineContent: diffLines[bestMatch].content
        };
      } else {
        // No match found - mark as unmatched
        matchResult = {
          ...savedComment,
          diffLineIndex: null,
          matchType: 'unmatched'
        };
      }
    }

    if (matchResult) {
      matched.push(matchResult);
    }
  });

  return matched;
}

// Simple similarity calculation (Levenshtein-based approximation)
function calculateSimilarity(str1, str2) {
  if (str1 === str2) return 1;
  if (!str1 || !str2) return 0;

  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  if (longer.length === 0) return 1;

  // Simple matching: count common characters
  const longerLower = longer.toLowerCase().trim();
  const shorterLower = shorter.toLowerCase().trim();

  if (longerLower.includes(shorterLower) || shorterLower.includes(longerLower)) {
    return 0.8;
  }

  // Count matching words
  const words1 = str1.toLowerCase().split(/\s+/);
  const words2 = str2.toLowerCase().split(/\s+/);
  const commonWords = words1.filter(w => words2.includes(w));

  return commonWords.length / Math.max(words1.length, words2.length);
}

// Load local repository
async function loadRepo() {
  const repoPath = document.getElementById('repoPath').value.trim();

  if (!repoPath) {
    showStatus('Please enter a repository path', 'error');
    return;
  }

  showStatus('Loading repository...', 'loading');
  document.getElementById('loadBtn').disabled = true;

  try {
    const response = await fetch(`${API_BASE}/load-repo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to load repository');
    }

    currentRepoId = data.repoId;
    currentFiles = data.files;

    // The server answers with the root of the working tree, which is not
    // always what was asked for: open a subdirectory and the repository above
    // it is what gets reviewed. Show the path that is actually loaded.
    if (data.repoPath) document.getElementById('repoPath').value = data.repoPath;

    if (data.files.length === 0) {
      showStatus('No uncommitted changes found in the repository', 'error');
      document.getElementById('loadBtn').disabled = false;
      return;
    }

    showStatus(data.message, 'success');
    displayFiles(data.files);

    // Load saved comments
    const savedComments = await loadCommentsFromBackend();
    if (savedComments.length > 0) {
      // Store saved comments in a global variable for matching later
      window.savedComments = savedComments;

      // Add all saved comments to the comments array immediately
      comments = savedComments.map(c => ({
        ...c,
        diffLineIndex: null, // Will be updated when file is loaded
        matchType: c.matchType || 'exact'
      }));

      // Show comments sidebar immediately
      updateCommentsSidebar();

      showStatus(`${data.message} - Loaded ${savedComments.length} saved comment(s)`, 'success');
    }

  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
  } finally {
    document.getElementById('loadBtn').disabled = false;
  }
}

// Display list of changed files
function displayFiles(files) {
  const sidebar = document.getElementById('sidebar');
  const filesList = document.getElementById('filesList');
  const fileCount = document.getElementById('fileCount');
  const submitBtn = document.getElementById('submitReviewBtn');
  const resizeHandle = document.getElementById('resizeHandle');

  filesList.innerHTML = files.map((fileObj, index) => {
    const file = fileObj.path;
    const status = fileObj.status;
    const parts = file.split('/');
    const filename = parts[parts.length - 1];
    const path = parts.slice(0, -1).join('/');

    // Because of RTL, we need to reverse the order in HTML
    const displayText = path ? `${path}/<span class="filename">${filename}</span>` : `<span class="filename">${filename}</span>`;
    const statusClass = status === 'A' ? 'file-status-added' : 'file-status-modified';
    const statusBadge = `<span class="file-status ${statusClass}">${status}</span>`;

    return `<div class="file-item" onclick="loadFile('${file}', ${index})" title="${escapeHtml(file)}">
      ${statusBadge}<span class="file-path-text">${displayText}</span>
    </div>`;
  }).join('');

  fileCount.textContent = `${files.length} file${files.length !== 1 ? 's' : ''}`;
  sidebar.classList.remove('hidden');
  resizeHandle.classList.remove('hidden');
  submitBtn.classList.remove('hidden');

  // Update comments sidebar
  updateCommentsSidebar();
}

// Load file content
async function loadFile(filePath, index) {
  if (!currentRepoId) return Promise.resolve();

  currentFile = filePath;
  currentFileIndex = index; // Track for keyboard navigation

  // Reset full context mode when switching files
  isFullContextMode = false;
  storedFullFileLines = null;

  // Update active file highlight and scroll into view
  document.querySelectorAll('.file-item').forEach((el, i) => {
    el.classList.toggle('active', i === index);
    if (i === index) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  try {
    const response = await fetch(`${API_BASE}/file/${currentRepoId}/${filePath}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to load file');
    }

    // Match saved comments to current diff if available
    if (window.savedComments && window.savedComments.length > 0) {
      const matchedComments = matchCommentsToDiff(window.savedComments, filePath, data.diffLines);

      // Update existing comments in the array with matched diff indices
      matchedComments.forEach(mc => {
        const existing = comments.find(c =>
          c.file === mc.file &&
          c.line === mc.line &&
          c.text === mc.text
        );

        if (existing) {
          // Update existing comment with new diff line index and match type
          existing.diffLineIndex = mc.diffLineIndex;
          existing.matchType = mc.matchType;
          existing.newLineContent = mc.newLineContent;
          // Preserve followUps from saved data
          if (mc.followUps) {
            existing.followUps = mc.followUps;
          }
        } else {
          // Add new comment if it doesn't exist
          comments.push({
            file: mc.file,
            diffLineIndex: mc.diffLineIndex,
            line: mc.line,
            lineContent: mc.lineContent,
            selectedText: mc.selectedText,
            text: mc.text,
            matchType: mc.matchType,
            newLineContent: mc.newLineContent,
            followUps: mc.followUps || []
          });
        }
      });

      // Update comments sidebar after matching comments
      updateCommentsSidebar();
    }

    displayCode(data.filePath, data.diffLines, data.binary);
    updateFullContextButton();
    return Promise.resolve();

  } catch (error) {
    showStatus(`Error loading file: ${error.message}`, 'error');
    return Promise.reject(error);
  }
}

// Display code with diff highlighting
function displayCode(filePath, diffLines, binary) {
  const codeSection = document.getElementById('codeSection');
  const currentFileEl = document.getElementById('currentFile');
  const codeViewer = document.getElementById('codeViewer');

  currentFileEl.textContent = filePath;
  currentDiffLines = diffLines; // Store for reference when adding comments

  // A binary file has no lines to show and none to comment on. Saying so is
  // the whole feature: it used to be decoded as UTF-8 and rendered as
  // mojibake, and a comment left on one of those lines exported an anchor
  // that could never match the file again.
  if (binary) {
    codeSection.style.display = 'block';
    codeViewer.innerHTML =
      '<div class="binary-notice">Binary file &mdash; not shown.' +
      '<span>git reports this file as binary, so there are no lines to ' +
      'review. Comments need a line to anchor to.</span></div>';
    return;
  }

  const fileComments = comments.filter(c => c.file === filePath);

  let html = '';
  diffLines.forEach((diffLine, index) => {
    // Use diffLineIndex to uniquely identify each line in the diff
    const diffLineIndex = index;
    const hasComment = fileComments.find(c => c.diffLineIndex === diffLineIndex);

    const lineClass = `line diff-${diffLine.type} ${hasComment ? 'commented' : ''}`;

    // Use the appropriate line number for clicking (newLine for add/unchanged, oldLine for delete)
    const clickableLineNum = diffLine.newLine || diffLine.oldLine;

    // Make both old and new line numbers clickable
    const oldLineClick = diffLine.type === 'delete' ? `onclick="toggleCommentInput(${diffLineIndex})"` : '';
    const newLineClick = diffLine.type !== 'delete' ? `onclick="toggleCommentInput(${diffLineIndex})"` : '';

    html += `
      <div class="${lineClass}" data-diff-index="${diffLineIndex}">
        ${hasComment ? '<span class="comment-indicator"></span>' : ''}
        <div class="line-numbers">
          <span class="old-line-number" ${oldLineClick}>${diffLine.oldLine || ''}</span>
          <span class="new-line-number" ${newLineClick}>${diffLine.newLine || ''}</span>
        </div>
        <div class="line-content">${escapeHtml(diffLine.content) || ' '}</div>
      </div>
    `;

    if (hasComment) {
      const selectedTextAttr = hasComment.selectedText ? `'${escapeHtml(hasComment.selectedText).replace(/'/g, "\\'")}'` : 'null';
      const matchTypeClass = hasComment.matchType === 'fuzzy' ? 'comment-box-fuzzy' : '';
      const fuzzyWarning = hasComment.matchType === 'fuzzy' ? `
        <div class="comment-fuzzy-warning">
          ⚠️ Code changed - comment anchored to similar line
          ${hasComment.newLineContent !== hasComment.lineContent ? `<div class="comment-original-code">Original: <code>${escapeHtml(hasComment.lineContent)}</code></div>` : ''}
        </div>
      ` : '';

      // Generate follow-ups HTML
      let followUpsHtml = '';
      if (hasComment.followUps && hasComment.followUps.length > 0) {
        followUpsHtml = '<div class="comment-followups">';
        hasComment.followUps.forEach((followUp, idx) => {
          const timestamp = followUp.timestamp ? new Date(followUp.timestamp).toLocaleString() : '';
          followUpsHtml += `
            <div class="comment-followup-item">
              <span class="followup-text">${escapeHtml(followUp.text)}</span>
              ${timestamp ? `<span class="followup-timestamp">${timestamp}</span>` : ''}
            </div>
          `;
        });
        followUpsHtml += '</div>';
      }

      html += `
        <div class="comment-box ${matchTypeClass}">
          ${fuzzyWarning}
          <span class="comment-text">${escapeHtml(hasComment.text)}</span>
          ${followUpsHtml}
          <div class="comment-actions">
            <button class="comment-reply" onclick="addFollowUp(${diffLineIndex})">Reply</button>
            <button class="comment-edit" onclick="editComment(${diffLineIndex}, ${selectedTextAttr})">Edit</button>
            <button class="comment-delete" onclick="deleteComment(${diffLineIndex})">Delete</button>
          </div>
        </div>
      `;
    }
  });

  // Show unmatched comments at the end
  const unmatchedComments = fileComments.filter(c => c.matchType === 'unmatched');
  if (unmatchedComments.length > 0) {
    html += '<div class="unmatched-comments-section">';
    unmatchedComments.forEach(comment => {
      const commentId = `unmatched-${Math.random().toString(36).substr(2, 9)}`;

      // Generate follow-ups for unmatched comments
      let unmatchedFollowUpsHtml = '';
      if (comment.followUps && comment.followUps.length > 0) {
        unmatchedFollowUpsHtml = '<div class="comment-followups">';
        comment.followUps.forEach((followUp, idx) => {
          const timestamp = followUp.timestamp ? new Date(followUp.timestamp).toLocaleString() : '';
          unmatchedFollowUpsHtml += `
            <div class="comment-followup-item">
              <span class="followup-text">${escapeHtml(followUp.text)}</span>
              ${timestamp ? `<span class="followup-timestamp">${timestamp}</span>` : ''}
            </div>
          `;
        });
        unmatchedFollowUpsHtml += '</div>';
      }

      html += `
        <div class="unmatched-comment-item collapsed" id="${commentId}">
          <div class="unmatched-comment-header" onclick="toggleUnmatchedComment('${commentId}')">
            <span class="unmatched-comment-icon">⚠️</span>
            <span class="unmatched-comment-title">Comment not found (Line ${comment.line} changed)</span>
            <span class="unmatched-comment-toggle">▶</span>
          </div>
          <div class="unmatched-comment-body">
            <div class="unmatched-comment-original">
              <strong>Original line:</strong>
              <code>${escapeHtml(comment.lineContent)}</code>
            </div>
            <div class="comment-text">${escapeHtml(comment.text)}</div>
            ${comment.selectedText ? `<div class="comment-item-selected">${escapeHtml(comment.selectedText)}</div>` : ''}
            ${unmatchedFollowUpsHtml}
            <div class="comment-actions">
              <button class="comment-reply" onclick="addFollowUpToUnmatched('${comment.file.replace(/'/g, "\\'")}', ${comment.line}, '${comment.text.replace(/'/g, "\\'")}')">Reply</button>
              <button class="comment-delete" onclick="deleteUnmatchedComment('${comment.file.replace(/'/g, "\\'")}', ${comment.line}, '${comment.text.replace(/'/g, "\\'")}')">Delete</button>
            </div>
          </div>
        </div>
      `;
    });
    html += '</div>';
  }

  codeViewer.innerHTML = html;
  codeSection.classList.remove('hidden');

  // Add text selection handler
  codeViewer.removeEventListener('mousedown', trackShiftKeyDown);
  codeViewer.removeEventListener('mouseup', handleTextSelection);
  codeViewer.addEventListener('mousedown', trackShiftKeyDown);
  codeViewer.addEventListener('mouseup', handleTextSelection);
}

// Toggle unmatched comment expansion
function toggleUnmatchedComment(commentId) {
  const element = document.getElementById(commentId);
  if (!element) return;

  element.classList.toggle('collapsed');
  const toggle = element.querySelector('.unmatched-comment-toggle');
  if (toggle) {
    toggle.textContent = element.classList.contains('collapsed') ? '▶' : '▼';
  }
}

// Delete unmatched comment
function deleteUnmatchedComment(file, line, text) {
  comments = comments.filter(c => !(c.file === file && c.line === line && c.text === text));

  // Auto-save to backend
  saveCommentsToBackend();

  // Update comments sidebar
  updateCommentsSidebar();

  // Reload the current file to remove the comment
  if (currentFile === file) {
    const fileIndex = currentFiles.findIndex(f => f.path === file);
    loadFile(file, fileIndex);
  }
}

// Add follow-up to a regular comment
function addFollowUp(diffLineIndex) {
  // Remove any existing follow-up input
  const existingInput = document.querySelector('.followup-input-box');
  if (existingInput) {
    existingInput.remove();
  }

  // Find the comment box
  const lineEl = document.querySelector(`.line[data-diff-index="${diffLineIndex}"]`);
  if (!lineEl) return;

  const commentBox = lineEl.nextElementSibling;
  if (!commentBox || !commentBox.classList.contains('comment-box')) return;

  // Create follow-up input
  const inputBox = document.createElement('div');
  inputBox.className = 'followup-input-box';
  inputBox.innerHTML = `
    <textarea placeholder="Enter your follow-up (Cmd/Ctrl+Enter to save)..." id="followupInput"></textarea>
    <div class="actions">
      <button onclick="saveFollowUp(${diffLineIndex})">Add Follow-up</button>
      <button class="cancel-btn" onclick="this.closest('.followup-input-box').remove()">Cancel</button>
    </div>
  `;

  // Insert after the comment actions
  const actionsDiv = commentBox.querySelector('.comment-actions');
  if (actionsDiv) {
    actionsDiv.after(inputBox);
  }

  const textarea = document.getElementById('followupInput');
  textarea.focus();

  // Auto-resize textarea
  const autoResize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };

  textarea.addEventListener('input', autoResize);
  autoResize();

  // Add keyboard shortcuts
  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      saveFollowUp(diffLineIndex);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      inputBox.remove();
    }
  });
}

// Save follow-up to a regular comment
function saveFollowUp(diffLineIndex) {
  const input = document.getElementById('followupInput');
  const text = input?.value.trim();

  if (!text) {
    showStatus('Please enter a follow-up comment', 'error');
    return;
  }

  const comment = comments.find(c => c.file === currentFile && c.diffLineIndex === diffLineIndex);
  if (!comment) return;

  // Initialize followUps if it doesn't exist
  if (!comment.followUps) {
    comment.followUps = [];
  }

  comment.followUps.push({
    text: text,
    timestamp: new Date().toISOString()
  });

  // Auto-save to backend
  saveCommentsToBackend();

  // Update comments sidebar
  updateCommentsSidebar();

  // Reload the current file to show the follow-up
  const fileIndex = currentFiles.findIndex(f => f.path === currentFile);
  loadFile(currentFile, fileIndex);
}

// Add follow-up to an unmatched comment
function addFollowUpToUnmatched(file, line, text) {
  // Remove any existing follow-up input
  const existingInput = document.querySelector('.followup-input-box');
  if (existingInput) {
    existingInput.remove();
  }

  // Find the unmatched comment element
  const unmatchedItems = document.querySelectorAll('.unmatched-comment-item');
  let targetItem = null;

  unmatchedItems.forEach(item => {
    const itemText = item.querySelector('.comment-text')?.textContent;
    const itemLine = item.querySelector('.unmatched-comment-title')?.textContent;
    if (itemText === text && itemLine?.includes(`Line ${line}`)) {
      targetItem = item;
    }
  });

  if (!targetItem) return;

  const commentBody = targetItem.querySelector('.unmatched-comment-body');
  if (!commentBody) return;

  // Create follow-up input
  const inputBox = document.createElement('div');
  inputBox.className = 'followup-input-box';

  // Generate unique ID for this specific input
  const inputId = `followupInput-${Math.random().toString(36).substr(2, 9)}`;

  inputBox.innerHTML = `
    <textarea placeholder="Enter your follow-up (Cmd/Ctrl+Enter to save)..." id="${inputId}"></textarea>
    <div class="actions">
      <button onclick="saveFollowUpToUnmatched('${file.replace(/'/g, "\\'")}', ${line}, '${text.replace(/'/g, "\\'")}', '${inputId}')">Add Follow-up</button>
      <button class="cancel-btn" onclick="this.closest('.followup-input-box').remove()">Cancel</button>
    </div>
  `;

  // Insert before the comment actions
  const actionsDiv = commentBody.querySelector('.comment-actions');
  if (actionsDiv) {
    actionsDiv.before(inputBox);
  }

  const textarea = document.getElementById(inputId);
  textarea.focus();

  // Auto-resize textarea
  const autoResize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };

  textarea.addEventListener('input', autoResize);
  autoResize();

  // Add keyboard shortcuts
  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      saveFollowUpToUnmatched(file, line, text, inputId);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      inputBox.remove();
    }
  });
}

// Save follow-up to an unmatched comment
function saveFollowUpToUnmatched(file, line, text, inputId) {
  const input = document.getElementById(inputId);
  const followUpText = input?.value.trim();

  if (!followUpText) {
    showStatus('Please enter a follow-up comment', 'error');
    return;
  }

  const comment = comments.find(c => c.file === file && c.line === line && c.text === text);
  if (!comment) return;

  // Initialize followUps if it doesn't exist
  if (!comment.followUps) {
    comment.followUps = [];
  }

  comment.followUps.push({
    text: followUpText,
    timestamp: new Date().toISOString()
  });

  // Auto-save to backend
  saveCommentsToBackend();

  // Update comments sidebar
  updateCommentsSidebar();

  // Reload the current file to show the follow-up
  if (currentFile === file) {
    const fileIndex = currentFiles.findIndex(f => f.path === file);
    loadFile(file, fileIndex);
  }
}

// Track command key state during selection
let commandKeyPressed = false;

// Track command key on mousedown
function trackShiftKeyDown(e) {
  commandKeyPressed = e.metaKey;
}

// Handle text selection in code viewer
function handleTextSelection(e) {
  const selection = window.getSelection();
  const rawSelectedText = selection.toString().trim();

  if (!rawSelectedText) {
    commandKeyPressed = false;
    return;
  }

  // Only trigger comment input if Command key was held during selection
  if (!commandKeyPressed) {
    commandKeyPressed = false;
    return;
  }

  // Reset command key tracking
  commandKeyPressed = false;

  // Extract only the code content, excluding line numbers
  const range = selection.getRangeAt(0);
  const container = document.createElement('div');
  container.appendChild(range.cloneContents());

  // Remove all line numbers from the cloned selection
  const lineNumbers = container.querySelectorAll('.line-numbers, .old-line-number, .new-line-number');
  lineNumbers.forEach(el => el.remove());

  // Extract text from each .line-content separately to avoid extra whitespace
  const lineContents = container.querySelectorAll('.line-content');
  let selectedText = '';

  if (lineContents.length > 0) {
    // Get text from each line-content and join with single newlines
    const lines = Array.from(lineContents).map(el => el.textContent);
    selectedText = lines.join('\n').trim();
  } else {
    // Fallback to full textContent if no line-content elements found
    selectedText = container.textContent.trim();
  }

  if (!selectedText) {
    selection.removeAllRanges();
    return;
  }

  // Find the line element where selection ends
  let targetElement = selection.focusNode;

  // Traverse up to find the line element
  while (targetElement && !targetElement.classList?.contains('line')) {
    targetElement = targetElement.parentElement;
  }

  if (!targetElement) {
    selection.removeAllRanges();
    return;
  }

  const diffLineIndex = parseInt(targetElement.dataset.diffIndex);
  if (diffLineIndex === undefined || isNaN(diffLineIndex)) {
    selection.removeAllRanges();
    return;
  }

  // Clear selection
  selection.removeAllRanges();

  // Show comment input with selected text
  toggleCommentInputWithSelection(diffLineIndex, selectedText);
}

// Toggle comment input
function toggleCommentInput(diffLineIndex) {
  toggleCommentInputWithSelection(diffLineIndex, null);
}

// Toggle comment input with optional selected text
function toggleCommentInputWithSelection(diffLineIndex, selectedText = null) {
  const existing = document.querySelector('.comment-input-box');
  if (existing) {
    existing.remove();
  }

  // Check if comment already exists
  if (comments.find(c => c.file === currentFile && c.diffLineIndex === diffLineIndex)) {
    return;
  }

  const lineEl = document.querySelector(`.line[data-diff-index="${diffLineIndex}"]`);
  const inputBox = document.createElement('div');
  inputBox.className = 'comment-input-box';

  // Show selected text if available
  const selectedTextHtml = selectedText
    ? `<div class="selected-text-preview">
         <strong>Selected code:</strong>
         <pre>${escapeHtml(selectedText)}</pre>
       </div>`
    : '';

  inputBox.innerHTML = `
    ${selectedTextHtml}
    <textarea placeholder="Enter your comment (Cmd/Ctrl+Enter to save)..." id="commentInput"></textarea>
    <div class="actions">
      <button onclick="saveComment(${diffLineIndex}, ${selectedText ? `\`${escapeHtml(selectedText).replace(/`/g, '\\`')}\`` : 'null'})">Save Comment</button>
      <button class="cancel-btn" onclick="this.closest('.comment-input-box').remove()">Cancel</button>
    </div>
  `;

  lineEl.after(inputBox);
  const textarea = document.getElementById('commentInput');
  textarea.focus();

  // Auto-resize textarea
  const autoResize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };

  textarea.addEventListener('input', autoResize);
  autoResize(); // Initial resize

  // Add keyboard shortcuts
  textarea.addEventListener('keydown', (e) => {
    // Cmd/Ctrl+Enter to save
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      saveComment(diffLineIndex, selectedText);
    }
    // Escape to close
    if (e.key === 'Escape') {
      e.preventDefault();
      inputBox.remove();
    }
  });
}

// Save comment
function saveComment(diffLineIndex, selectedText = null) {
  const input = document.getElementById('commentInput');
  const text = input.value.trim();

  if (!text) {
    showStatus('Please enter a comment', 'error');
    return;
  }

  // Find the diff line
  const diffLine = currentDiffLines[diffLineIndex];
  if (!diffLine) return;

  const lineContent = diffLine.content || '';
  const lineNum = diffLine.newLine || diffLine.oldLine;

  comments.push({
    file: currentFile,
    diffLineIndex: diffLineIndex,
    line: lineNum,
    lineContent: lineContent,
    selectedText: selectedText,
    text: text,
    matchType: 'exact', // New comments are exact matches
    followUps: [] // Initialize empty follow-ups array
  });

  // Auto-save to backend
  saveCommentsToBackend();

  // Update comments sidebar
  updateCommentsSidebar();

  // Reload the current file to show the new comment
  const fileIndex = currentFiles.findIndex(f => f.path === currentFile);
  loadFile(currentFile, fileIndex);
}

// Edit comment
function editComment(diffLineIndex, selectedText = null) {
  const comment = comments.find(c => c.file === currentFile && c.diffLineIndex === diffLineIndex);
  if (!comment) return;

  // Remove the comment from the list temporarily
  comments = comments.filter(c => !(c.file === currentFile && c.diffLineIndex === diffLineIndex));

  // Reload file and show edit input
  const fileIndex = currentFiles.findIndex(f => f.path === currentFile);
  loadFile(currentFile, fileIndex).then(() => {
    // Show comment input with existing text
    const lineEl = document.querySelector(`.line[data-diff-index="${diffLineIndex}"]`);
    if (!lineEl) return;

    const inputBox = document.createElement('div');
    inputBox.className = 'comment-input-box';

    const selectedTextHtml = selectedText
      ? `<div class="selected-text-preview">
           <strong>Selected code:</strong>
           <pre>${escapeHtml(selectedText)}</pre>
         </div>`
      : '';

    inputBox.innerHTML = `
      ${selectedTextHtml}
      <textarea placeholder="Enter your comment (Cmd/Ctrl+Enter to save)..." id="commentInput">${escapeHtml(comment.text)}</textarea>
      <div class="actions">
        <button onclick="saveComment(${diffLineIndex}, ${selectedText ? `\`${escapeHtml(selectedText).replace(/`/g, '\\`')}\`` : 'null'})">Save Comment</button>
        <button class="cancel-btn" onclick="this.closest('.comment-input-box').remove()">Cancel</button>
      </div>
    `;

    lineEl.after(inputBox);
    const textarea = document.getElementById('commentInput');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    // Auto-resize textarea
    const autoResize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    };

    textarea.addEventListener('input', autoResize);
    autoResize(); // Initial resize

    // Add keyboard shortcuts
    textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        saveComment(diffLineIndex, selectedText);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        inputBox.remove();
        // Restore the comment if canceled
        comments.push(comment);
        const fileIndex = currentFiles.findIndex(f => f.path === currentFile);
        loadFile(currentFile, fileIndex);
      }
    });
  });
}

// Delete comment
function deleteComment(diffLineIndex) {
  comments = comments.filter(c => !(c.file === currentFile && c.diffLineIndex === diffLineIndex));

  // Auto-save to backend
  saveCommentsToBackend();

  // Update comments sidebar
  updateCommentsSidebar();

  // Reload the current file to remove the comment
  const fileIndex = currentFiles.findIndex(f => f.path === currentFile);
  loadFile(currentFile, fileIndex);
}

// Submit review
async function submitReview() {
  if (!currentRepoId) {
    showStatus('Please load a repository first', 'error');
    return;
  }

  // Ensure comments are saved before generating review
  await saveCommentsToBackend();

  try {
    const response = await fetch(`${API_BASE}/submit-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoId: currentRepoId
        // Backend reads from JSON file (single source of truth)
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to submit review');
    }

    showReviewModal(data.reviewContent, data.filename);
    showStatus(`Review submitted successfully! ${data.totalComments} comments`, 'success');

  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
  }
}

// Show review modal with download and copy options
function showReviewModal(reviewContent, filename) {
  // Create modal overlay
  const modal = document.createElement('div');
  modal.className = 'review-modal';
  modal.innerHTML = `
    <div class="review-modal-content">
      <div class="review-modal-header">
        <h2>Review Submitted</h2>
        <button class="close-modal" onclick="this.closest('.review-modal').remove()">×</button>
      </div>
      <div class="review-modal-body">
        <pre class="review-text">${escapeHtml(reviewContent)}</pre>
      </div>
      <div class="review-modal-footer">
        <button onclick="downloadReview('${filename}', this.closest('.review-modal').querySelector('.review-text').textContent)">
          Download ${filename}
        </button>
        <button onclick="copyReviewToClipboard(this.closest('.review-modal').querySelector('.review-text').textContent)">
          Copy to Clipboard
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

// Download review as file
function downloadReview(filename, content) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  showStatus('Review downloaded successfully', 'success');
}

// Copy review to clipboard
async function copyReviewToClipboard(content) {
  try {
    await navigator.clipboard.writeText(content);
    showStatus('Review copied to clipboard!', 'success');
  } catch (error) {
    showStatus('Failed to copy to clipboard', 'error');
  }
}

// Cleanup session
async function cleanupRepo() {
  if (!currentRepoId) return;

  try {
    await fetch(`${API_BASE}/cleanup/${currentRepoId}`, {
      method: 'DELETE'
    });

    showStatus('Session cleared', 'success');
    resetApp();

  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

// Reset application
function resetApp() {
  currentRepoId = null;
  currentFiles = [];
  currentFile = null;
  currentFileIndex = -1;
  comments = [];

  document.getElementById('repoPath').value = '';
  document.getElementById('sidebar').classList.add('hidden');
  document.getElementById('resizeHandle').classList.add('hidden');
  document.getElementById('codeSection').classList.add('hidden');
  document.getElementById('commentsSidebar').classList.add('hidden');
  document.getElementById('submitReviewBtn').classList.add('hidden');
  document.getElementById('status').textContent = '';
  document.getElementById('status').className = 'status';
}

// Show status message
function showStatus(message, type) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = 'Status: ' + message;
  statusEl.className = `status ${type}`;
}

// Track if we're in full context mode
let isFullContextMode = false;
let storedFullFileLines = null;

// Toggle between full context and diff-only view
async function showFullContext() {
  if (!currentRepoId || !currentFile) return;

  if (isFullContextMode) {
    // Switch back to diff view
    displayCode(currentFile, currentDiffLines);
    isFullContextMode = false;
    updateFullContextButton();
  } else {
    // Switch to full context
    try {
      const response = await fetch(`${API_BASE}/file-full/${currentRepoId}/${currentFile}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to load full file content');
      }

      storedFullFileLines = data.lines;
      displayFullContext(data.filePath, data.lines);
      isFullContextMode = true;
      updateFullContextButton();

    } catch (error) {
      showStatus(`Error loading full context: ${error.message}`, 'error');
    }
  }
}

// Update the full context button text
function updateFullContextButton() {
  const button = document.querySelector('.full-context-btn');
  if (button) {
    const icon = button.querySelector('svg');
    if (isFullContextMode) {
      button.innerHTML = icon.outerHTML + ' Show Diff Only';
    } else {
      button.innerHTML = icon.outerHTML + ' Full Context';
    }
  }
}

// Display full file content with deleted lines
function displayFullContext(filePath, lines) {
  const codeViewer = document.getElementById('codeViewer');
  const fileComments = comments.filter(c => c.file === filePath);

  // Create a merged view: currentDiffLines + missing lines from full content
  const mergedLines = [];
  const coveredNewLines = new Set();

  // First, add all diff lines (includes deleted, added, and changed lines)
  let lastNewLine = 0;
  currentDiffLines.forEach(diffLine => {
    // Check if we need to fill in any missing lines before this diffLine
    if (diffLine.newLine && diffLine.newLine > lastNewLine + 1) {
      // Fill in the gap with unchanged lines
      for (let i = lastNewLine + 1; i < diffLine.newLine; i++) {
        if (lines[i - 1] !== undefined) {
          mergedLines.push({
            oldLine: i,
            newLine: i,
            type: 'unchanged',
            content: lines[i - 1]
          });
          coveredNewLines.add(i);
        }
      }
    }

    mergedLines.push(diffLine);
    if (diffLine.newLine) {
      coveredNewLines.add(diffLine.newLine);
      lastNewLine = diffLine.newLine;
    }
  });

  // Add any remaining lines after the last diff
  for (let i = lastNewLine + 1; i <= lines.length; i++) {
    if (!coveredNewLines.has(i) && lines[i - 1] !== undefined) {
      mergedLines.push({
        oldLine: i,
        newLine: i,
        type: 'unchanged',
        content: lines[i - 1]
      });
    }
  }

  // Find matching diffLineIndex for comments in full context
  // Need to map mergedLines back to original diffLines indices
  const mergedToDiffIndexMap = new Map();
  mergedLines.forEach((mergedLine, mergedIndex) => {
    // Find this line in original diffLines
    const diffIndex = currentDiffLines.findIndex(dl =>
      (dl.newLine === mergedLine.newLine && dl.oldLine === mergedLine.oldLine && dl.content === mergedLine.content)
    );
    if (diffIndex !== -1) {
      mergedToDiffIndexMap.set(mergedIndex, diffIndex);
    }
  });

  // Now render the merged lines
  let html = '';
  mergedLines.forEach((diffLine, mergedIndex) => {
    const diffLineIndex = mergedToDiffIndexMap.get(mergedIndex);
    const hasComment = diffLineIndex !== undefined ? fileComments.find(c => c.diffLineIndex === diffLineIndex) : null;

    const lineClass = `line diff-${diffLine.type} ${hasComment ? 'commented' : ''}`;
    const dataDiffIndexAttr = diffLineIndex !== undefined ? `data-diff-index="${diffLineIndex}"` : '';

    html += `
      <div class="${lineClass}" ${dataDiffIndexAttr}>
        ${hasComment ? '<span class="comment-indicator"></span>' : ''}
        <div class="line-numbers">
          <span class="old-line-number">${diffLine.oldLine || ''}</span>
          <span class="new-line-number" ${diffLineIndex !== undefined ? `onclick="toggleCommentInput(${diffLineIndex})"` : ''}>${diffLine.newLine || ''}</span>
        </div>
        <div class="line-content">${escapeHtml(diffLine.content) || ' '}</div>
      </div>
    `;

    if (hasComment) {
      const selectedTextAttr = hasComment.selectedText ? `'${escapeHtml(hasComment.selectedText).replace(/'/g, "\\'")}'` : 'null';
      html += `
        <div class="comment-box">
          <span class="comment-text">${escapeHtml(hasComment.text)}</span>
          <div class="comment-actions">
            <button class="comment-edit" onclick="editComment(${diffLineIndex}, ${selectedTextAttr})">Edit</button>
            <button class="comment-delete" onclick="deleteComment(${diffLineIndex})">Delete</button>
          </div>
        </div>
      `;
    }
  });

  codeViewer.innerHTML = html;

  // Add text selection handler for full context too
  codeViewer.removeEventListener('mousedown', trackShiftKeyDown);
  codeViewer.removeEventListener('mouseup', handleTextSelection);
  codeViewer.addEventListener('mousedown', trackShiftKeyDown);
  codeViewer.addEventListener('mouseup', handleTextSelection);

  showStatus('Showing full file context', 'success');
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Sidebar resize functionality
function initResizeHandle() {
  const resizeHandle = document.getElementById('resizeHandle');
  const sidebar = document.getElementById('sidebar');
  const commentsResizeHandle = document.getElementById('commentsResizeHandle');
  const commentsSidebar = document.getElementById('commentsSidebar');
  let isResizing = false;
  let isResizingComments = false;

  // Left sidebar resize
  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizeHandle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  // Comments sidebar resize
  commentsResizeHandle.addEventListener('mousedown', (e) => {
    isResizingComments = true;
    commentsResizeHandle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (isResizing) {
      const newWidth = e.clientX;
      const minWidth = 200;
      const maxWidth = 600;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        sidebar.style.width = `${newWidth}px`;
      }
    }

    if (isResizingComments) {
      const newWidth = window.innerWidth - e.clientX;
      const minWidth = 250;
      const maxWidth = 600;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        commentsSidebar.style.width = `${newWidth}px`;
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      resizeHandle.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    if (isResizingComments) {
      isResizingComments = false;
      commentsResizeHandle.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// Track current file index for keyboard navigation
let currentFileIndex = -1;

// Update comments sidebar
function updateCommentsSidebar() {
  const sidebar = document.getElementById('commentsSidebar');
  const commentsList = document.getElementById('commentsList');
  const commentsCount = document.getElementById('commentsCount');
  const commentsResizeHandle = document.getElementById('commentsResizeHandle');

  commentsCount.textContent = comments.length;

  if (comments.length === 0) {
    sidebar.classList.add('hidden');
    commentsResizeHandle.classList.add('hidden');
    commentsList.innerHTML = '<div style="text-align: center; color: #586069; padding: 20px; font-size: 13px;">No comments yet</div>';
    return;
  }

  sidebar.classList.remove('hidden');
  commentsResizeHandle.classList.remove('hidden');

  // Group comments by file
  const commentsByFile = {};
  comments.forEach(comment => {
    if (!commentsByFile[comment.file]) {
      commentsByFile[comment.file] = [];
    }
    commentsByFile[comment.file].push(comment);
  });

  let html = '';
  for (const [file, fileComments] of Object.entries(commentsByFile)) {
    fileComments
      .sort((a, b) => a.line - b.line)
      .forEach(comment => {
        const selectedHtml = comment.selectedText
          ? `<div class="comment-item-selected">${escapeHtml(comment.selectedText)}</div>`
          : '';

        const fileEscaped = file.replace(/'/g, "\\'");
        html += `
          <div class="comment-item">
            <button class="comment-item-delete" onclick="event.stopPropagation(); deleteCommentFromSidebar('${fileEscaped}', ${comment.diffLineIndex})" title="Delete comment">×</button>
            <div class="comment-item-content" onclick="jumpToComment('${fileEscaped}', ${comment.diffLineIndex})">
              <div class="comment-item-file">${escapeHtml(file)}</div>
              <div class="comment-item-line">Line ${comment.line}</div>
              <div class="comment-item-text">${escapeHtml(comment.text)}</div>
              ${selectedHtml}
            </div>
          </div>
        `;
      });
  }

  commentsList.innerHTML = html;
}

// Delete comment from sidebar
function deleteCommentFromSidebar(file, diffLineIndex) {
  comments = comments.filter(c => !(c.file === file && c.diffLineIndex === diffLineIndex));

  // Auto-save to backend
  saveCommentsToBackend();

  // Update comments sidebar
  updateCommentsSidebar();

  // If we're currently viewing this file, reload it to remove the comment
  if (currentFile === file) {
    const fileIndex = currentFiles.findIndex(f => f.path === file);
    loadFile(file, fileIndex);
  }
}

// Jump to a specific comment
function jumpToComment(file, diffLineIndex) {
  // Find the file index
  const fileIndex = currentFiles.findIndex(f => f.path === file);
  if (fileIndex === -1) return;

  // Load the file
  loadFile(file, fileIndex).then(() => {
    // Scroll to the comment
    const lineEl = document.querySelector(`.line[data-diff-index="${diffLineIndex}"]`);
    if (lineEl) {
      lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Highlight briefly
      lineEl.style.backgroundColor = 'rgba(3, 102, 214, 0.1)';
      setTimeout(() => {
        lineEl.style.backgroundColor = '';
      }, 1000);
    }
  });
}

// Navigate to next/previous file
function navigateFiles(direction) {
  if (currentFiles.length === 0) return;

  let newIndex = currentFileIndex;

  // If no file is loaded yet, load the first file
  if (currentFileIndex === -1) {
    newIndex = 0;
  } else if (direction === 'up') {
    newIndex = currentFileIndex > 0 ? currentFileIndex - 1 : 0;
  } else if (direction === 'down') {
    newIndex = currentFileIndex < currentFiles.length - 1 ? currentFileIndex + 1 : currentFiles.length - 1;
  }

  if (newIndex !== currentFileIndex) {
    currentFileIndex = newIndex;
    const file = currentFiles[newIndex].path;
    loadFile(file, newIndex);
  }
}

// Allow Enter key to load repo
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('repoPath').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      loadRepo();
    }
  });

  // Initialize resize handle
  initResizeHandle();

  // Add keyboard navigation for files
  document.addEventListener('keydown', (e) => {
    // Only handle arrow keys when not in an input/textarea
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateFiles('up');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateFiles('down');
    }
  });

  // `reviewer /path/to/repo` opens the page with the repository in the query
  // string, so the review is on screen without anyone typing a path.
  const requestedRepo = new URLSearchParams(window.location.search).get('repo');
  if (requestedRepo) {
    document.getElementById('repoPath').value = requestedRepo;
    loadRepo();
  }
});
