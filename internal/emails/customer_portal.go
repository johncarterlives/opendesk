package emails

import (
	"fmt"

	"github.com/useopendesk/opendesk/internal/mailer"
)

// CustomerPortalReset lets an existing contact choose their own portal password.
func CustomerPortalReset(s Site, brand, link string) mailer.Mail {
	return s.build(mailer.Email{
		Subject: "Choose your password for " + brand, Preheader: "Use this link to set or reset your customer portal password.",
		Eyebrow: brand, Heading: "Choose your password",
		Intro:  []string{"Someone asked to set or reset your password for the customer portal of " + brand + "."},
		Button: &mailer.Button{Label: "Choose password", URL: link},
		Outro:  []string{"The link works for one hour and only once. Choosing a password signs you out on your other devices."},
		Footer: mailer.Footer{Reason: "You get this email because a password link was requested for this address. If it was not you, ignore it and nothing changes.", Contact: s.Contact},
	})
}

// CustomerPortalPasswordChanged tells a contact that their sign-in credentials changed.
func CustomerPortalPasswordChanged(s Site, brand, link string) mailer.Mail {
	return s.build(mailer.Email{
		Subject: "Your customer portal password was changed", Eyebrow: brand, Heading: "Your password was changed",
		Intro:  []string{"Your password for the customer portal of " + brand + " was changed. Every session was signed out.", "If this was not you, request a new password link now and contact the support team."},
		Button: &mailer.Button{Label: "Open customer portal", URL: link},
		Footer: mailer.Footer{Reason: "You get this email whenever your customer portal password changes.", Contact: s.Contact},
	})
}

// CustomerPortalInvite invites a contact to the customer portal of brand with a one-time
// link to choose a password (contracts/customer-portal.md "Invitations").
func CustomerPortalInvite(s Site, brand, link string, days int) mailer.Mail {
	return s.build(mailer.Email{
		Subject: "You're invited to the customer portal of " + brand, Preheader: "Choose a password to follow your requests online.",
		Eyebrow: brand, Heading: "Follow your requests online",
		Intro:  []string{"The team at " + brand + " invited you to its customer portal, where you can see your support requests, follow their progress and reply to them."},
		Button: &mailer.Button{Label: "Choose your password", URL: link},
		Outro:  []string{fmt.Sprintf("The link works for %d days and only once. After that, ask for a new link on the portal's sign-in page.", days)},
		Footer: mailer.Footer{Reason: "You get this email because the support team of " + brand + " invited this address. If you do not want an account, ignore it and nothing changes.", Contact: s.Contact},
	})
}
