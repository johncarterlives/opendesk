package panels

import (
	"errors"
	"slices"
	"strings"
)

// The fields of Shopify's answer a panel can show (contracts/integrations.md "Ticket panels"):
// the customer's, then each order's. The customer's name and link, and each order's number,
// date, total and cancellation, always show.
const (
	FieldTags              = "tags"
	FieldEmail             = "email"
	FieldOrdersCount       = "orders_count"
	FieldTotalSpent        = "total_spent"
	FieldFinancialStatus   = "financial_status"
	FieldFulfillmentStatus = "fulfillment_status"
	FieldLineItems         = "line_items"
	FieldLinePrices        = "line_prices"
	FieldShipping          = "shipping"
	FieldDiscounts         = "discounts"
	FieldRefunds           = "refunds"
	FieldTracking          = "tracking"
)

// shopifyFields is the catalogue, in the order settings lists it.
var shopifyFields = []string{
	FieldTags, FieldEmail, FieldOrdersCount, FieldTotalSpent,
	FieldFinancialStatus, FieldFulfillmentStatus, FieldLineItems, FieldLinePrices, FieldShipping, FieldDiscounts, FieldRefunds, FieldTracking,
}

// defaultFields is what a panel shows until an admin chooses: everything but the customer's
// email, which is the ticket's contact's own.
var defaultFields = slices.DeleteFunc(slices.Clone(shopifyFields), func(f string) bool { return f == FieldEmail })

// defaultOrdersShown is how many of the last orders a panel shows until an admin chooses.
const defaultOrdersShown = shopifyOrders

// fieldSet is the fields a panel shows.
type fieldSet map[string]bool

func newFieldSet(fields []string) fieldSet {
	s := fieldSet{}
	for _, f := range fields {
		s[f] = true
	}
	return s
}

// normalizeFields checks a chosen list against the catalogue and answers it in catalogue order,
// without repeats. Unit prices are part of the lines, so they need them.
func normalizeFields(in []string) ([]string, error) {
	chosen := fieldSet{}
	for _, f := range in {
		f = strings.TrimSpace(f)
		if !slices.Contains(shopifyFields, f) {
			return nil, errors.New("Unknown field \"" + clip(f, 40) + "\": choose from " + strings.Join(shopifyFields, ", ") + ".")
		}
		chosen[f] = true
	}
	if chosen[FieldLinePrices] && !chosen[FieldLineItems] {
		return nil, errors.New("line_prices needs line_items: a unit price shows on its line.")
	}
	out := []string{}
	for _, f := range shopifyFields {
		if chosen[f] {
			out = append(out, f)
		}
	}
	return out, nil
}

// shownFields is what the panel shows: the admin's choice, else the defaults.
func (x *row) shownFields() []string {
	if x.Kind != KindShopify {
		return []string{}
	}
	if x.Fields == nil {
		return slices.Clone(defaultFields)
	}
	return slices.Clone(*x.Fields)
}
