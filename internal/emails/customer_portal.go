package emails

import "github.com/useopendesk/opendesk/internal/mailer"

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
