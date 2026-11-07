"""Static menu, recipes and ingredient catalogue for the simulated restaurant.

The restaurant is a fast-casual taqueria/brunch spot: small menu, a few shared
ingredients so that one ingredient running low touches several dishes, which is
what makes the stockout prediction interesting to watch.
"""

# ingredient name -> (unit, on_hand at open, par level, location, days_in_stock at open)
INGREDIENTS = {
    # avocado is the star of the demo: short stock, heavy demand, most perishable thing in the walk-in
    "avocado":        ("each", 14,  30, "walk-in",     4),
    "chicken":        ("lb",   45,  60, "walk-in",     2),
    "carnitas":       ("lb",   38,  50, "walk-in",     1),
    "tortilla":       ("each", 400, 500, "dry",        3),
    "sourdough":      ("slice", 110, 140, "dry",       1),
    "eggs":           ("each", 180, 240, "walk-in",    5),
    "tomato":         ("each", 60,  80, "walk-in",     3),
    "cheese":         ("oz",   320, 400, "walk-in",    6),
    "fry_oil":        ("L",    18,  20, "fry-station", 0),   # tracked by the nose, not by count
    "potatoes":       ("lb",   60,  80, "dry",         4),
    "horchata":       ("cup",  48,  60, "line",        1),
    "salsa_verde":    ("oz",   256, 320, "line",       2),
}

PRETTY = {"fry_oil": "fry oil", "salsa_verde": "salsa verde"}


def pretty(name: str) -> str:
    return PRETTY.get(name, name.replace("_", " "))

# menu id -> dict
MENU = [
    {"id": "avo_toast", "name": "Avocado Toast", "price": 11.0,
     "ingredients": {"avocado": 1, "sourdough": 2, "tomato": 0.5},
     "tags": ["brunch", "veg"], "prep_minutes": 6},
    {"id": "tomato_toast", "name": "Heirloom Tomato Toast", "price": 9.5,
     "ingredients": {"sourdough": 2, "tomato": 1.5, "cheese": 1},
     "tags": ["brunch", "veg"], "prep_minutes": 5},
    {"id": "chicken_burrito", "name": "Chicken Burrito", "price": 12.5,
     "ingredients": {"chicken": 0.4, "tortilla": 1, "cheese": 2, "salsa_verde": 2},
     "tags": ["lunch"], "prep_minutes": 7},
    {"id": "carnitas_tacos", "name": "Carnitas Tacos (3)", "price": 12.0,
     "ingredients": {"carnitas": 0.35, "tortilla": 3, "salsa_verde": 2},
     "tags": ["lunch"], "prep_minutes": 6},
    {"id": "guac_chips", "name": "Guacamole & Chips", "price": 7.5,
     "ingredients": {"avocado": 1.5, "tortilla": 2, "tomato": 0.3},
     "tags": ["side", "veg"], "prep_minutes": 3},
    {"id": "breakfast_burrito", "name": "Breakfast Burrito", "price": 11.5,
     "ingredients": {"eggs": 3, "tortilla": 1, "cheese": 2, "potatoes": 0.3, "avocado": 0.5},
     "tags": ["brunch"], "prep_minutes": 8},
    {"id": "fries", "name": "Crispy Fries", "price": 4.5,
     "ingredients": {"potatoes": 0.5, "fry_oil": 0.02},
     "tags": ["side", "veg", "fryer"], "prep_minutes": 4},
    {"id": "horchata", "name": "Horchata", "price": 4.0,
     "ingredients": {"horchata": 1},
     "tags": ["drink"], "prep_minutes": 1},
]

# When an item is pulled, what do we promote instead (same craving, no shared scarce ingredient)?
SUBSTITUTES = {
    "avo_toast": "tomato_toast",
    "guac_chips": "fries",
    "carnitas_tacos": "chicken_burrito",
    "chicken_burrito": "carnitas_tacos",
    "breakfast_burrito": "chicken_burrito",
}

# Relative order popularity by channel (weights). DoorDash leans lunch, walk-ins lean brunch.
POPULARITY = {
    "doordash": {"chicken_burrito": 5, "carnitas_tacos": 4, "guac_chips": 4, "avo_toast": 3,
                 "fries": 3, "horchata": 2, "breakfast_burrito": 2, "tomato_toast": 1},
    "ubereats": {"chicken_burrito": 4, "carnitas_tacos": 3, "fries": 3, "avo_toast": 3,
                 "guac_chips": 3, "horchata": 1, "breakfast_burrito": 2, "tomato_toast": 1},
    "phone":    {"carnitas_tacos": 4, "chicken_burrito": 4, "guac_chips": 2, "fries": 2,
                 "avo_toast": 1, "horchata": 1, "breakfast_burrito": 1, "tomato_toast": 1},
    "walkin":   {"avo_toast": 5, "breakfast_burrito": 4, "horchata": 3, "guac_chips": 2,
                 "chicken_burrito": 2, "fries": 2, "tomato_toast": 2, "carnitas_tacos": 1},
}

CHANNEL_PREFIX = {"doordash": "D", "ubereats": "U", "phone": "P", "walkin": "W"}

# Average refund cost to the merchant when an unavailable item is ordered and then cancelled/refunded.
REFUND_COST_PER_INCIDENT_USD = 9.80

EMOJI = {"avo_toast": "🥑", "tomato_toast": "🍅", "chicken_burrito": "🌯", "carnitas_tacos": "🌮",
         "guac_chips": "🥣", "breakfast_burrito": "🍳", "fries": "🍟", "horchata": "🥤"}
