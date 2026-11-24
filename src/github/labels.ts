/** The Issue labels Nibfin reads and writes (Proposal §4). */
export const nibfinLabels = {
  scope: "scope",
  shaped: "shaped",
  delivered: "delivered",
  pause: "pause",
  /** Set by Nibfin when a person must act; removing it is the go-ahead (#674). */
  pending: "pending",
} as const;
