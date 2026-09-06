ALTER TABLE public.admission_applications ADD CONSTRAINT application_applicant_pair UNIQUE(application_id,applicant_id);
CREATE TABLE public.applicant_account_links (
 applicant_id text PRIMARY KEY REFERENCES public.admission_applicants(applicant_id),
 person_id text NOT NULL REFERENCES public.person_profiles(person_id),
 linked_at timestamptz NOT NULL,
 invitation_id text NOT NULL UNIQUE
);
CREATE TABLE public.applicant_account_invitations (
 invitation_id text PRIMARY KEY,
 application_id text NOT NULL REFERENCES public.admission_applications(application_id),
 applicant_id text NOT NULL REFERENCES public.admission_applicants(applicant_id),
 token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,
 state text NOT NULL CHECK (state IN ('Open','Revoked','Claimed')),
 issued_by text NOT NULL REFERENCES public.person_profiles(person_id),
 issued_at timestamptz NOT NULL,
 UNIQUE(invitation_id,applicant_id),
 FOREIGN KEY(application_id,applicant_id) REFERENCES public.admission_applications(application_id,applicant_id),
 CHECK(issued_at<expires_at)
);
ALTER TABLE public.applicant_account_invitations ADD COLUMN generation bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE public.applicant_account_links ADD CONSTRAINT applicant_account_link_invitation_fk
 FOREIGN KEY(invitation_id,applicant_id) REFERENCES public.applicant_account_invitations(invitation_id,applicant_id);
CREATE UNIQUE INDEX applicant_account_one_open ON public.applicant_account_invitations(applicant_id) WHERE state='Open';
CREATE TABLE public.applicant_account_delivery (
 invitation_id text PRIMARY KEY REFERENCES public.applicant_account_invitations(invitation_id),
 state text NOT NULL CHECK(state IN ('Pending','Claimed','Delivered','Cancelled')),
 secret text,
 recipient text NOT NULL,
 envelope jsonb,
 claim_id text,
 claimed_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 CHECK ((state IN ('Delivered','Cancelled') AND secret IS NULL AND envelope IS NULL AND claim_id IS NULL AND claimed_at IS NULL)
 OR (state='Pending' AND secret IS NOT NULL AND claim_id IS NULL AND claimed_at IS NULL)
 OR (state='Claimed' AND secret IS NOT NULL AND claim_id IS NOT NULL AND claimed_at IS NOT NULL))
);
CREATE TABLE public.applicant_account_audit (
 audit_id text PRIMARY KEY,
 applicant_id text NOT NULL REFERENCES public.admission_applicants(applicant_id),
 invitation_id text NOT NULL REFERENCES public.applicant_account_invitations(invitation_id),
 actor_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
 action text NOT NULL CHECK(action IN ('Issued','Revoked','NewAccountClaimed','ExistingAccountClaimed')),
 occurred_at timestamptz NOT NULL
);
CREATE FUNCTION public.prevent_applicant_account_relink() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Applicant account association is immutable'; END $$;
CREATE TRIGGER applicant_account_link_immutable BEFORE UPDATE OR DELETE ON public.applicant_account_links FOR EACH ROW EXECUTE FUNCTION public.prevent_applicant_account_relink();

CREATE TRIGGER applicant_account_audit_immutable BEFORE UPDATE OR DELETE ON public.applicant_account_audit FOR EACH ROW EXECUTE FUNCTION public.prevent_applicant_account_relink();

CREATE FUNCTION public.guard_applicant_account_invitation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR (OLD.state<>'Open' AND NEW.state<>OLD.state) THEN
 RAISE EXCEPTION 'Invitation identity and terminal states are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER applicant_account_invitation_guard BEFORE UPDATE OR DELETE ON public.applicant_account_invitations FOR EACH ROW EXECUTE FUNCTION public.guard_applicant_account_invitation();
CREATE FUNCTION public.guard_applicant_account_envelope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.invitation_id<>OLD.invitation_id OR NEW.recipient<>OLD.recipient OR (OLD.envelope IS NOT NULL AND NEW.envelope IS NOT NULL AND NEW.envelope<>OLD.envelope) OR (NEW.secret IS NOT NULL AND NEW.secret IS DISTINCT FROM OLD.secret) OR (OLD.state IN ('Delivered','Cancelled') AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Delivery identity and prepared envelope are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER applicant_account_envelope_guard BEFORE UPDATE ON public.applicant_account_delivery FOR EACH ROW EXECUTE FUNCTION public.guard_applicant_account_envelope();
