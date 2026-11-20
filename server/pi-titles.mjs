// A title is optional metadata: generation never holds up a conversation's task lane.
export function createPiTitles(metadata, generate) {
  let closed = false;
  return {
    consider(owner, task, output) {
      if (
        closed ||
        !generate ||
        task.assistance ||
        !metadata.claimAITitle(owner, task.conversationId)
      )
        return;
      void Promise.resolve()
        .then(() =>
          generate({ input: task.input.slice(0, 1000), output: output.slice(0, 1000), owner }),
        )
        .then((title) => {
          if (!closed) metadata.applyAITitle(owner, task.conversationId, title);
        })
        .catch(() => {
          /* Keep the first-message fallback; never replace it with invented AI output. */
        });
    },
    close() {
      closed = true;
    },
  };
}
