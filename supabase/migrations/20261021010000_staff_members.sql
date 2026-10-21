-- Staff directory managed by authenticated administrators.
-- Staff records are intentionally separate from auth profiles: being listed as
-- staff does not grant an account access to the admin application.

CREATE TABLE IF NOT EXISTS public.staff_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  email TEXT NOT NULL,
  phone TEXT,
  job_title TEXT NOT NULL CHECK (char_length(job_title) BETWEEN 1 AND 100),
  department TEXT NOT NULL CHECK (char_length(department) BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'on_leave')),
  avatar_url TEXT,
  joined_at DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_members_email_unique
  ON public.staff_members (lower(email));
CREATE INDEX IF NOT EXISTS idx_staff_members_status
  ON public.staff_members (status);
CREATE INDEX IF NOT EXISTS idx_staff_members_department
  ON public.staff_members (department);
CREATE INDEX IF NOT EXISTS idx_staff_members_created_at
  ON public.staff_members (created_at DESC);

DROP TRIGGER IF EXISTS update_staff_members_updated_at ON public.staff_members;
CREATE TRIGGER update_staff_members_updated_at
  BEFORE UPDATE ON public.staff_members
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.staff_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage staff" ON public.staff_members;
CREATE POLICY "Admins can manage staff" ON public.staff_members
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Private directory records follow the existing cookie-authenticated API and
-- polling model. Do not publish staff personal data to realtime WAL streams.

