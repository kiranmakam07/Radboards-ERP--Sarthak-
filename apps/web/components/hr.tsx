'use client';

import { INTERVIEW_RESULTS } from '@radcore/shared';
import { Form, label } from '@/components/ui';
import { post } from '@/lib/api';

/** Record how an interview round went. Used by HR on the applicant's page and by the interviewer on "My work". */
export function InterviewResult({ interviewId, onDone }: { interviewId: string; onDone: () => void }) {
  return (
    <Form submit="Save result" inline
      fields={[
        { name: 'result', label: 'Result', type: 'select', required: true, options: INTERVIEW_RESULTS.map((r) => ({ value: r, label: label(r) })) },
        { name: 'rating', label: 'Rating (1 to 5)', type: 'number', step: '1' },
        { name: 'feedback', label: 'Feedback', type: 'textarea' },
      ]}
      onSubmit={(v) => post(`/hr/interviews/${interviewId}/complete`, v)}
      onDone={onDone} />
  );
}
