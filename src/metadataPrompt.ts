import * as vscode from 'vscode';

export interface NoteMetadata {
  title: string;
  dateKey?: string; // YYYY-MM-DD
  dateStrForFilename?: string; // MM-DD-YY or YYYY-MM-DD
  tags: string[];
}

/** Local calendar date as YYYY-MM-DD. (toISOString gives the UTC date, which is wrong in the evening west of UTC.) */
export function localDateKey(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function promptMetadata(
  initialTitle?: string,
  titlePrompt = 'Title for the note',
  titlePlaceholder = 'e.g. Q3 Migration Plan'
): Promise<NoteMetadata | undefined> {
  // 1. Title Prompt
  const title = await vscode.window.showInputBox({
    prompt: titlePrompt,
    value: initialTitle,
    placeHolder: titlePlaceholder,
  });

  if (title === undefined) {
    return undefined; // Cancelled
  }

  const finalTitle = title.trim();
  if (!finalTitle && !initialTitle) {
    return undefined;
  }

  // 2. Date Pick Prompt (Optional)
  const todayStr = localDateKey();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = localDateKey(yesterday);

  const dateChoice = await vscode.window.showQuickPick([
    { label: '$(circle-slash) No Date', description: 'Skip adding date context', id: 'skip' },
    { label: `📅 Today (${todayStr})`, description: 'Use today\'s date', id: 'today', value: todayStr },
    { label: `📅 Yesterday (${yesterdayStr})`, description: 'Use yesterday\'s date', id: 'yesterday', value: yesterdayStr },
    { label: '✏️ Custom Date...', description: 'Type a custom date manually', id: 'custom' },
  ], {
    placeHolder: 'Add Date context? (Optional)'
  });

  if (dateChoice === undefined) {
    return undefined; // Cancelled
  }

  let dateKey: string | undefined = undefined;
  let dateStrForFilename: string | undefined = undefined;

  if (dateChoice) {
    if (dateChoice.id === 'today' || dateChoice.id === 'yesterday') {
      dateKey = dateChoice.value;
      dateStrForFilename = dateChoice.value; // default to ISO
    } else if (dateChoice.id === 'custom') {
      const customDate = await vscode.window.showInputBox({
        prompt: 'Enter date (e.g. M-D-YY or YYYY-MM-DD)',
        value: todayStr,
      });
      if (customDate === undefined) {
        return undefined; // Cancelled
      }
      if (customDate.trim()) {
        const parsed = parseDateInput(customDate);
        if (parsed) {
          dateKey = parsed.dailyKey;
          dateStrForFilename = parsed.original;
        } else {
          const d = new Date(customDate.trim());
          if (!isNaN(d.getTime())) {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            dateKey = `${y}-${m}-${day}`;
            dateStrForFilename = customDate.trim();
          } else {
            vscode.window.showWarningMessage(`Invalid date format entered. Proceeding without date.`);
          }
        }
      }
    }
  }

  // 3. Tags Pick Prompt (Optional)
  const tagsChoice = await vscode.window.showQuickPick([
    { label: 'meetings', description: 'Meeting notes, calls, syncs' },
    { label: 'projects', description: 'Project boards, tasks, milestones' },
    { label: 'emails', description: 'Email copy, correspondence' },
    { label: 'ideas', description: 'Brainstorming, draft content' },
    { label: 'todo', description: 'Action items, checklists' },
    { label: 'notes', description: 'General thoughts, records' },
    { label: 'archive', description: 'Archived notes, backups' },
    { label: '✏️ Add custom tag...', description: 'Type a custom tag manually', id: 'custom' },
  ], {
    placeHolder: 'Select tags for this note (Press Space to select, Enter to finish) - Optional',
    canPickMany: true,
  });

  if (tagsChoice === undefined) {
    return undefined; // Cancelled
  }

  const tags: string[] = [];
  if (tagsChoice.length > 0) {
    let customTagWanted = false;
    for (const t of tagsChoice) {
      if ((t as any).id === 'custom') {
        customTagWanted = true;
      } else {
        tags.push(t.label);
      }
    }
    if (customTagWanted) {
      const customTag = await vscode.window.showInputBox({
        prompt: 'Enter custom tag',
        placeHolder: 'e.g. brainstorming',
      });
      if (customTag === undefined) {
        return undefined; // Cancelled
      }
      if (customTag.trim()) {
        tags.push(customTag.trim().toLowerCase().replace(/[^a-z0-9-]+/g, ''));
      }
    }
  }

  return {
    title: finalTitle || initialTitle || 'Untitled',
    dateKey,
    dateStrForFilename,
    tags,
  };
}

function parseDateInput(input: string): { dailyKey: string; original: string } | undefined {
  const trimmed = input.trim();
  if (!trimmed) { return undefined; }

  // 1. Try parsing Year-first format: YYYY-MM-DD or YYYY_MM_DD
  const yearFirst = trimmed.match(/^(\d{4})[-_](\d{1,2})[-_](\d{1,2})$/);
  if (yearFirst) {
    const y = yearFirst[1];
    const m = yearFirst[2].padStart(2, '0');
    const d = yearFirst[3].padStart(2, '0');
    return { dailyKey: `${y}-${m}-${d}`, original: trimmed };
  }

  // 2. Try parsing US-first format: MM-DD-YY or MM-DD-YYYY or M-D-YY
  const usFirst = trimmed.match(/^(\d{1,2})[-_](\d{1,2})[-_](\d{2,4})$/);
  if (usFirst) {
    let y = usFirst[3];
    if (y.length === 2) {
      y = '20' + y; // e.g. 25 -> 2025
    }
    const m = usFirst[1].padStart(2, '0');
    const d = usFirst[2].padStart(2, '0');
    return { dailyKey: `${y}-${m}-${d}`, original: trimmed };
  }

  return undefined;
}
