// Presentation only: these observations never replace Core receipts or admission.
export function observeStageProgress(execute) {
  const progress = [];
  return {
    progress,
    execute: async (stage, ...args) => {
      const entry = { stage, status: 'started' };
      progress.push(entry);
      try {
        const result = await execute(stage, ...args);
        entry.status = result.status;
        if (result.code) entry.code = result.code;
        return result;
      } catch (error) {
        entry.status = 'interrupted';
        throw error;
      }
    },
  };
}
