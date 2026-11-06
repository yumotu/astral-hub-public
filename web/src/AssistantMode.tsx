import { useId } from 'react';
export function AssistantMode({
  value,
  projectName,
  readOnly,
  locked,
  onChange,
}: {
  value: 'read' | 'edit';
  projectName?: string;
  readOnly?: boolean;
  locked?: string;
  onChange: (value: 'read' | 'edit') => void;
}) {
  const id = useId();
  const reason =
    locked ||
    (!projectName
      ? '选择已授权的项目后可启用文件修改。'
      : readOnly
        ? '这个项目只授权读取，不能启用文件修改。'
        : '');
  return (
    <div>
      <label className="assistant-setting-row" htmlFor={id}>
        <span>
          允许修改文件<small>{value === 'edit' ? '可修改' : '只读'}</small>
        </span>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={value === 'edit'}
          disabled={!!reason}
          aria-describedby={reason ? id + '-reason' : undefined}
          onChange={(e) => onChange(e.target.checked ? 'edit' : 'read')}
        />
      </label>
      {reason && (
        <p className="field-help" id={id + '-reason'}>
          {reason}
        </p>
      )}
    </div>
  );
}
