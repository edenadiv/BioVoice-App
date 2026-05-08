export type StageStatus = "pending" | "active" | "done";

export type Stage = {
  id: string;
  label: string;
  status: StageStatus;
};

type StageListProps = {
  stages: Stage[];
};

function StageIcon({ status, index }: { status: StageStatus; index: number }) {
  if (status === "done") {
    return (
      <span className="bv-stage-row__icon" aria-hidden="true">
        ✓
      </span>
    );
  }
  if (status === "active") {
    return <span className="bv-stage-row__icon" aria-hidden="true" />;
  }
  return (
    <span className="bv-stage-row__icon" aria-hidden="true">
      {index + 1}
    </span>
  );
}

export function StageList({ stages }: StageListProps) {
  return (
    <ol className="bv-stages" aria-label="Pipeline progress">
      {stages.map((stage, index) => (
        <li key={stage.id} className={`bv-stage-row bv-stage-row--${stage.status}`}>
          <StageIcon status={stage.status} index={index} />
          <span className="bv-stage-row__label">{stage.label}</span>
        </li>
      ))}
    </ol>
  );
}
