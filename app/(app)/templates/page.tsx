import { PendingFeature } from '@/components/ui/PendingFeature';

export default function TemplatesPage() {
  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">Templates</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        HTML/CSS email builder with variables, versioning, and personalized preview.
      </p>
      <PendingFeature
        title="Templates"
        phase="Phase 2 (HTML/CSS editor, variables, preview, test emails, versioning)"
        note="Template/TemplateVersion tables already exist in prisma/schema.prisma."
      />
    </div>
  );
}
