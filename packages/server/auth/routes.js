const Router = require("express-promise-router");

const db = require("@saltcorn/data/db");
const User = require("@saltcorn/data/models/user");
const Field = require("@saltcorn/data/models/field");
const Form = require("@saltcorn/data/models/form");
const File = require("@saltcorn/data/models/file");

const { send_verification_email } = require("@saltcorn/data/models/email");
const {
  setTenant,
  error_catcher,
  loggedIn,
  csrfField,
} = require("../routes/utils.js");
const { getState } = require("@saltcorn/data/db/state");
const { send_reset_email } = require("./resetpw");
const { renderForm } = require("@saltcorn/markup");
const passport = require("passport");
const {
  a,
  text,
  table,
  tbody,
  th,
  td,
  tr,
  form,
  select,
  option,
  i,
} = require("@saltcorn/markup/tags");
const {
  available_languages,
  check_email_mask,
} = require("@saltcorn/data/models/config");
const rateLimit = require("express-rate-limit");
const moment = require("moment");
const View = require("@saltcorn/data/models/view");
const Table = require("@saltcorn/data/models/table");
const { InvalidConfiguration } = require("@saltcorn/data/utils");
const Trigger = require("@saltcorn/data/models/trigger");
const { restore_backup } = require("../markup/admin.js");
const { restore } = require("@saltcorn/data/models/backup");
const load_plugins = require("../load_plugins");
const fs = require("fs");

const router = new Router();
module.exports = router;

const loginForm = (req, isCreating) => {
  const postAuthMethods = Object.entries(getState().auth_methods)
    // TBD unresolved parameter K
    // TBD unresolved postUsernamePassword
    .filter(([k, v]) => v.postUsernamePassword)
    .map(([k, v]) => v);
  const user_sublabel = postAuthMethods
    // TBD unresolved usernameLabel
    .map((auth) => `${auth.usernameLabel} for ${auth.label}`)
    .join(", ");
  return new Form({
    class: "login",
    fields: [
      new Field({
        label: req.__("E-mail"),
        name: "email",
        type: "String",
        attributes: {
          input_type: "email",
        },
        sublabel: user_sublabel || undefined,
        validator: (s) => s.length < 128,
      }),
      new Field({
        label: req.__("Password"),
        name: "password",
        input_type: "password",
        validator: isCreating
          ? (pw) => User.unacceptable_password_reason(pw)
          : undefined,
      }),
    ],
    action: "/auth/login",
    submitLabel: req.__("Login"),
  });
};
const forgotForm = (req) =>
  new Form({
    blurb: req.__(
      "Enter your email address below and we'll send you a link to reset your password."
    ),
    fields: [
      new Field({
        label: req.__("E-mail"),
        name: "email",
        type: "String",
        attributes: {
          input_type: "email",
        },
        validator: (s) => s.length < 128,
      }),
    ],
    action: "/auth/forgot",
    submitLabel: req.__("Reset password"),
  });

const resetForm = (body, req) => {
  const form = new Form({
    blurb: req.__("Enter your new password below"),
    fields: [
      new Field({
        label: req.__("Password"),
        name: "password",
        input_type: "password",
      }),
      new Field({
        name: "token",
        input_type: "hidden",
      }),
      new Field({
        name: "email",
        input_type: "hidden",
      }),
    ],
    action: "/auth/reset",
    submitLabel: req.__("Set password"),
  });
  form.values.email = body && body.email;
  form.values.token = body && body.token;
  return form;
};
const getAuthLinks = (current, noMethods) => {
  const links = { methods: [] };
  const state = getState();
  if (current !== "login") links.login = "/auth/login";
  if (current !== "signup" && state.getConfig("allow_signup"))
    links.signup = "/auth/signup";
  if (current !== "forgot" && state.getConfig("allow_forgot"))
    links.forgot = "/auth/forgot";
  if (!noMethods)
    Object.entries(getState().auth_methods).forEach(([name, auth]) => {
      const url = auth.postUsernamePassword
        ? `javascript:$('form.login').attr('action','/auth/login-with/${name}').submit();`
        : `/auth/login-with/${name}`;
      links.methods.push({
        icon: auth.icon,
        label: auth.label,
        name,
        url,
      });
    });
  return links;
};

router.get(
  "/login",
  setTenant,
  error_catcher(async (req, res) => {
    const login_form_name = getState().getConfig("login_form", "");
    if (login_form_name) {
      const login_form = await View.findOne({ name: login_form_name });
      if (!login_form)
        res.sendAuthWrap(
          req.__(`Login`),
          loginForm(req),
          getAuthLinks("login")
        );
      else {
        const resp = await login_form.run_possibly_on_page({}, req, res);
        if (login_form.default_render_page) res.sendWrap(req.__(`Login`), resp);
        else res.sendAuthWrap(req.__(`Login`), resp, { methods: [] });
      }
    } else
      res.sendAuthWrap(req.__(`Login`), loginForm(req), getAuthLinks("login"));
  })
);

router.get("/logout", setTenant, (req, res, next) => {
  req.logout();
  if (req.session.destroy)
    req.session.destroy((err) => {
      if (err) return next(err);
      req.logout();
      res.redirect("/auth/login");
    });
  else {
    req.logout();
    req.session = null;
    res.redirect("/auth/login");
  }
});

router.get(
  "/forgot",
  setTenant,
  error_catcher(async (req, res) => {
    if (getState().getConfig("allow_forgot", false)) {
      res.sendAuthWrap(
        req.__(`Reset password`),
        forgotForm(req),
        getAuthLinks("forgot")
      );
    } else {
      req.flash(
        "danger",
        req.__("Password reset not enabled. Contact your administrator.")
      );
      res.redirect("/auth/login");
    }
  })
);

router.get(
  "/reset",
  setTenant,
  error_catcher(async (req, res) => {
    const form = resetForm(req.query, req);
    res.sendAuthWrap(req.__(`Reset password`), form, {});
  })
);

router.get(
  "/verify",
  setTenant,
  error_catcher(async (req, res) => {
    const { token, email } = req.query;
    const result = await User.verifyWithToken({
      email,
      verification_token: token,
    });
    if (result.error) req.flash("danger", result.error);
    else if (result) {
      req.flash("success", req.__("Email verified"));
      const u = await User.findOne({ email });
      if (u) u.relogin(req);
    }
    res.redirect("/");
  })
);

router.post(
  "/reset",
  setTenant,
  error_catcher(async (req, res) => {
    const result = await User.resetPasswordWithToken({
      email: req.body.email,
      reset_password_token: req.body.token,
      password: req.body.password,
    });
    if (result.success) {
      req.flash(
        "success",
        req.__("Password reset. Log in with your new password")
      );
    } else {
      req.flash("danger", result.error);
    }
    res.redirect("/auth/login");
  })
);
router.post(
  "/forgot",
  setTenant,
  error_catcher(async (req, res) => {
    if (getState().getConfig("allow_forgot")) {
      const { email } = req.body;
      const u = await User.findOne({ email });
      const respond = () => {
        req.flash("success", req.__("Email with password reset link sent"));
        res.redirect("/auth/login");
      };
      if (!u) {
        respond();
        return;
      }
      //send email
      await send_reset_email(u, req);

      respond();
    } else {
      req.flash(
        "danger",
        req.__("Password reset not enabled. Contact your administrator.")
      );
      res.redirect("/auth/login");
    }
  })
);
router.get(
  "/signup",
  setTenant,
  error_catcher(async (req, res) => {
    if (!getState().getConfig("allow_signup")) {
      req.flash("danger", req.__("Signups not enabled"));
      res.redirect("/auth/login");
      return;
    }
    const defaultSignup = async () => {
      const form = loginForm(req, true);
      const new_user_form = getState().getConfig("new_user_form", "");
      if (!new_user_form) {
        const userTable = await Table.findOne({ name: "users" });
        const userFields = await userTable.getFields();

        for (const f of userFields) {
          if (f.required && !f.calculated && !["id", "email"].includes(f.name))
            form.fields.push(f);
        }
      }
      form.action = "/auth/signup";
      form.submitLabel = req.__("Sign up");
      res.sendAuthWrap(req.__(`Sign up`), form, getAuthLinks("signup"));
    };
    const signup_form_name = getState().getConfig("signup_form", "");
    if (signup_form_name) {
      const signup_form = await View.findOne({ name: signup_form_name });
      if (!signup_form) await defaultSignup();
      else {
        const resp = await signup_form.run_possibly_on_page({}, req, res);
        if (signup_form.default_render_page)
          res.sendWrap(req.__(`Sign up`), resp);
        else res.sendAuthWrap(req.__(`Sign up`), resp, { methods: [] });
      }
    } else await defaultSignup();
  })
);

router.get(
  "/create_first_user",
  setTenant,
  error_catcher(async (req, res) => {
    const hasUsers = await User.nonEmpty();
    if (!hasUsers) {
      const form = loginForm(req, true);
      form.action = "/auth/create_first_user";
      form.submitLabel = req.__("Create user");
      form.blurb = req.__(
        "Please create your first user account, which will have administrative privileges. You can add other users and give them administrative privileges later."
      );
      const restore = restore_backup(
        req.csrfToken(),
        [i({ class: "fas fa-upload mr-2 mt-2" }), req.__("Restore a backup")],
        `/auth/create_from_restore`
      );
      res.sendAuthWrap(req.__(`Create first user`), form, {}, restore);
    } else {
      req.flash("danger", req.__("Users already present"));
      res.redirect("/auth/login");
    }
  })
);

router.post(
  "/create_from_restore",
  setTenant,
  error_catcher(async (req, res) => {
    const hasUsers = await User.nonEmpty();
    if (!hasUsers) {
      const newPath = File.get_new_path();
      await req.files.file.mv(newPath);
      const err = await restore(
        newPath,
        (p) => load_plugins.loadAndSaveNewPlugin(p),
        true
      );
      if (err) req.flash("error", err);
      else req.flash("success", req.__("Successfully restored backup"));
      fs.unlink(newPath, function () {});
      res.redirect(`/auth/login`);
    } else {
      req.flash("danger", req.__("Users already present"));
      res.redirect("/auth/login");
    }
  })
);
router.post(
  "/create_first_user",
  setTenant,
  error_catcher(async (req, res) => {
    const hasUsers = await User.nonEmpty();
    if (!hasUsers) {
      const form = loginForm(req, true);
      form.validate(req.body);

      if (form.hasErrors) {
        form.action = "/auth/create_first_user";
        form.submitLabel = req.__("Create user");
        form.blurb = req.__(
          "Please create your first user account, which will have administrative privileges. You can add other users and give them administrative privileges later."
        );
        res.sendAuthWrap(req.__(`Create first user`), form, {});
      } else {
        const { email, password } = form.values;
        const u = await User.create({ email, password, role_id: 1 });
        req.login(
          {
            email: u.email,
            id: u.id,
            role_id: u.role_id,
            tenant: db.getTenantSchema(),
          },
          function (err) {
            if (!err) {
              Trigger.emitEvent("Login", null, u);
              res.redirect("/");
            } else {
              req.flash("danger", err);
              res.redirect("/auth/signup");
            }
          }
        );
      }
    } else {
      req.flash("danger", req.__("Users already present"));
      res.redirect("/auth/login");
    }
  })
);

const getNewUserForm = async (new_user_view_name, req, askEmail) => {
  const view = await View.findOne({ name: new_user_view_name });
  if (!view)
    throw new InvalidConfiguration("New user form view does not exist");
  const table = await Table.findOne({ name: "users" });
  const fields = await table.getFields();
  const { columns, layout } = view.configuration;

  const tfields = (columns || [])
    .map((column) => {
      if (column.type === "Field") {
        const f = fields.find((fld) => fld.name === column.field_name);
        if (f) {
          f.fieldview = column.fieldview;
          if (f.type === "Key") {
            if (getState().keyFieldviews[column.fieldview])
              f.fieldviewObj = getState().keyFieldviews[column.fieldview];
            f.input_type =
              !f.fieldview || !f.fieldviewObj || f.fieldview === "select"
                ? "select"
                : "fromtype";
          }
          return f;
        }
      }
    })
    .filter((tf) => !!tf);

  const form = new Form({
    action: `/auth/signup_final`,
    fields: tfields,
    layout,
    submitLabel: req.__("Sign up"),
  });
  await form.fill_fkey_options();
  if (askEmail) {
    form.fields.push(
      new Field({
        name: "email",
        label: req.__("Email"),
        type: "String",
        attributes: {
          input_type: "email",
        },
        required: true,
      })
    );
    form.layout = {
      above: [
        {
          type: "blank",
          contents: "Email",
        },
        {
          type: "field",
          fieldview: "edit",
          field_name: "email",
        },
        {
          type: "line_break",
        },
        form.layout,
      ],
    };
  } else {
    form.hidden("email");
  }
  form.hidden("password");
  return form;
};

const signup_login_with_user = (u, req, res) =>
  req.login(
    {
      email: u.email,
      id: u.id,
      role_id: u.role_id,
      tenant: db.getTenantSchema(),
    },
    function (err) {
      if (!err) {
        Trigger.emitEvent("Login", null, u);
        if (getState().verifier) res.redirect("/auth/verification-flow");
        else res.redirect("/");
      } else {
        req.flash("danger", err);
        res.redirect("/auth/signup");
      }
    }
  );

router.get(
  "/signup_final_ext",
  setTenant,
  error_catcher(async (req, res) => {
    const new_user_form = getState().getConfig("new_user_form");
    if (!req.user || req.user.id || !new_user_form) {
      req.flash("danger", req.__("This is the wrong place"));
      res.redirect("/auth/login");
      return;
    }
    const form = await getNewUserForm(new_user_form, req, !req.user.email);
    form.action = "/auth/signup_final_ext";
    form.values.email = req.user.email;
    res.sendAuthWrap(new_user_form, form, getAuthLinks("signup", true));
  })
);

router.post(
  "/signup_final_ext",
  setTenant,
  error_catcher(async (req, res) => {
    const new_user_form = getState().getConfig("new_user_form");
    if (!req.user || req.user.id || !new_user_form) {
      req.flash("danger", req.__("This is the wrong place"));
      res.redirect("/auth/login");
      return;
    }
    const form = await getNewUserForm(new_user_form, req, !req.user.email);
    form.action = "/auth/signup_final_ext";

    form.validate(req.body);
    if (form.hasErrors) {
      res.sendAuthWrap(new_user_form, form, getAuthLinks("signup", true));
      return;
    }
    try {
      const uobj = { ...req.user, ...form.values };
      if (uobj.email && !check_email_mask(uobj.email)) {
        form.errors._form = req.__(
          "Signups with this email address are not accepted"
        );
        res.sendAuthWrap(new_user_form, form, getAuthLinks("signup", true));
        return;
      }
      const u = await User.create(uobj);
      await send_verification_email(u, req);

      signup_login_with_user(u, req, res);
    } catch (e) {
      const table = await Table.findOne({ name: "users" });
      const fields = await table.getFields();
      form.hasErrors = true;
      const unique_field_error = fields.find(
        (f) =>
          e.message ===
          `duplicate key value violates unique constraint "users_${f.name}_unique"`
      );
      if (unique_field_error)
        form.errors[unique_field_error.name] = req.__("Already in use");
      else form.errors._form = e.message;
      res.sendAuthWrap(new_user_form, form, getAuthLinks("signup", true));
    }
  })
);
router.post(
  "/signup_final",
  setTenant,
  error_catcher(async (req, res) => {
    if (getState().getConfig("allow_signup")) {
      const new_user_form = getState().getConfig("new_user_form");
      const form = await getNewUserForm(new_user_form, req);
      const signup_form_name = getState().getConfig("signup_form", "");
      if (signup_form_name) {
        const signup_form = await View.findOne({ name: signup_form_name });
        if (signup_form) {
          signup_form.configuration.columns.forEach((col) => {
            if (
              col.type === "Field" &&
              !["email", "password"].includes(col.field_name)
            ) {
              form.hidden(col.field_name);
            }
          });
        }
      }
      form.validate(req.body);
      if (form.hasErrors) {
        res.sendAuthWrap(new_user_form, form, getAuthLinks("signup", true));
      } else if (form.values.email && !check_email_mask(form.values.email)) {
        form.errors._form = req.__(
          "Signups with this email address are not accepted"
        );
        res.sendAuthWrap(new_user_form, form, getAuthLinks("signup", true));
      } else {
        try {
          const u = await User.create(form.values);
          await send_verification_email(u, req);

          signup_login_with_user(u, req, res);
        } catch (e) {
          const table = await Table.findOne({ name: "users" });
          const fields = await table.getFields();
          form.hasErrors = true;
          const unique_field_error = fields.find(
            (f) =>
              e.message ===
              `duplicate key value violates unique constraint "users_${f.name}_unique"`
          );
          if (unique_field_error)
            form.errors[unique_field_error.name] = req.__("Already in use");
          else form.errors._form = e.message;
          res.sendAuthWrap(new_user_form, form, getAuthLinks("signup", true));
        }
      }
    } else {
      req.flash("danger", req.__("Signups not enabled"));
      res.redirect("/auth/login");
    }
  })
);

router.post(
  "/signup",
  setTenant,
  error_catcher(async (req, res) => {
    if (!getState().getConfig("allow_signup")) {
      req.flash("danger", req.__("Signups not enabled"));
      res.redirect("/auth/login");
      return;
    }

    const unsuitableEmailPassword = async (email, password, passwordRepeat) => {
      if (!email || !password) {
        req.flash("danger", req.__("E-mail and password required"));
        res.redirect("/auth/signup");
        return true;
      }
      if (email.length > 127) {
        req.flash("danger", req.__("E-mail too long"));
        res.redirect("/auth/signup");
        return true;
      }
      if (!User.valid_email(email)) {
        req.flash("danger", req.__("Not a valid e-mail address"));
        res.redirect("/auth/signup");
        return true;
      }
      if (!check_email_mask(email)) {
        req.flash(
          "danger",
          req.__("Signups with this email address are not accepted")
        );
        res.redirect("/auth/signup");
        return true;
      }
      if (typeof passwordRepeat === "string" && password !== passwordRepeat) {
        req.flash("danger", req.__("Passwords do not match"));
        res.redirect("/auth/signup");
        return true;
      }

      const us = await User.find({ email });
      if (us.length > 0) {
        req.flash("danger", req.__("Account already exists"));
        res.redirect("/auth/signup");
        return true;
      }
      const pwcheck = User.unacceptable_password_reason(password);
      if (pwcheck) {
        req.flash("danger", pwcheck);
        res.redirect("/auth/signup");
        return true;
      }
    };
    const new_user_form = getState().getConfig("new_user_form");

    const signup_form_name = getState().getConfig("signup_form", "");
    if (signup_form_name) {
      const signup_form = await View.findOne({ name: signup_form_name });
      if (signup_form) {
        const userObject = {};
        signup_form.configuration.columns.forEach((col) => {
          if (col.type === "Field") {
            if (col.field_name === "passwordRepeat")
              userObject[col.field_name] = req.body[col.field_name] || "";
            else userObject[col.field_name] = req.body[col.field_name];
          }
        });
        const { email, password, passwordRepeat } = userObject;
        if (await unsuitableEmailPassword(email, password, passwordRepeat))
          return;
        if (new_user_form) {
          const form = await getNewUserForm(new_user_form, req);
          Object.entries(userObject).forEach(([k, v]) => {
            form.values[k] = v;
            if (!form.fields.find((f) => f.name === k)) form.hidden(k);
          });
          res.sendAuthWrap(new_user_form, form, getAuthLinks("signup", true));
        } else {
          const u = await User.create(userObject);
          await send_verification_email(u, req);

          signup_login_with_user(u, req, res);
        }
        return;
      }
    }

    const form = loginForm(req, true);
    form.validate(req.body);

    if (form.hasErrors) {
      form.action = "/auth/signup";
      form.submitLabel = req.__("Sign up");
      res.sendAuthWrap(req.__(`Sign up`), form, getAuthLinks("signup"));
    } else {
      const { email, password } = form.values;
      if (await unsuitableEmailPassword(email, password)) return;
      if (new_user_form) {
        const form = await getNewUserForm(new_user_form, req);
        form.values.email = email;
        form.values.password = password;
        res.sendAuthWrap(new_user_form, form, getAuthLinks("signup", true));
      } else {
        const u = await User.create({ email, password });
        await send_verification_email(u, req);

        signup_login_with_user(u, req, res);
      }
    }
  })
);

function handler(req, res) {
  console.log(
    `Failed login attempt for: ${req.body.email} from ${req.ip} UA ${req.get(
      "User-Agent"
    )}`
  );
  req.flash(
    "error",
    "You've made too many failed attempts in a short period of time, please try again " +
      moment(req.rateLimit.resetTime).fromNow()
  );
  res.redirect("/auth/login"); // brute force protection triggered, send them back to the login page
}
// try to find a unique user id in login submit
const userIdKey = (body) => {
  if (body.email) return body.email;
  const { remember, password, _csrf, passwordRepeat, ...rest } = body;
  const kvs = Object.entries(rest);
  if (kvs.length > 0) return kvs[0][1];
  else return "nokey";
};
const ipLimiter = rateLimit({
  // TBD create config parameter
  windowMs: 60 * 60 * 1000, // 60 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  handler,
});

const userLimiter = rateLimit({
  // TBD create config parameter
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3, // limit each IP to 100 requests per windowMs
  keyGenerator: (req) => userIdKey(req.body),
  handler,
});

router.post(
  "/login",
  setTenant,
  ipLimiter,
  userLimiter,
  passport.authenticate("local", {
    //successRedirect: "/",
    failureRedirect: "/auth/login",
    failureFlash: true,
  }),
  error_catcher(async (req, res) => {
    ipLimiter.resetKey(req.ip);
    userLimiter.resetKey(userIdKey(req.body));
    if (req.session.cookie)
      if (req.body.remember) {
        // TBD create config parameter
        req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // Cookie expires after 30 days
      } else {
        req.session.cookie.expires = false; // Cookie expires at end of session
      }
    Trigger.emitEvent("Login", null, req.user);
    req.flash("success", req.__("Welcome, %s!", req.user.email));
    res.redirect("/");
  })
);
router.get(
  "/login-with/:method",
  setTenant,
  error_catcher(async (req, res, next) => {
    const { method } = req.params;
    const auth = getState().auth_methods[method];
    if (auth) {
      passport.authenticate(method, auth.parameters)(req, res, next);
    } else {
      req.flash(
        "danger",
        req.__("Unknown authentication method %s", text(method))
      );
      res.redirect("/");
    }
  })
);
router.post(
  "/login-with/:method",
  setTenant,
  error_catcher(async (req, res, next) => {
    const { method } = req.params;
    const auth = getState().auth_methods[method];
    console.log(method, auth);
    if (auth) {
      passport.authenticate(method, auth.parameters)(
        req,
        res,
        loginCallback(req, res)
      );
    } else {
      req.flash(
        "danger",
        req.__("Unknown authentication method %s", text(method))
      );
      res.redirect("/");
    }
  })
);

const loginCallback = (req, res) => () => {
  if (!req.user) return;
  if (!req.user.id) {
    res.redirect("/auth/signup_final_ext");
  }
  if (!req.user.email) {
    res.redirect("/auth/set-email");
  } else {
    Trigger.emitEvent("Login", null, req.user);
    req.flash("success", req.__("Welcome, %s!", req.user.email));
    res.redirect("/");
  }
};

router.get(
  "/callback/:method",
  setTenant,
  error_catcher(async (req, res, next) => {
    const { method } = req.params;
    const auth = getState().auth_methods[method];
    if (auth) {
      passport.authenticate(method, { failureRedirect: "/auth/login" })(
        req,
        res,
        loginCallback(req, res)
      );
    }
  })
);

const changPwForm = (req) =>
  new Form({
    action: "/auth/settings",
    submitLabel: req.__("Change"),
    submitButtonClass: "btn-outline-primary",
    onChange: "remove_outline(this)",
    fields: [
      {
        label: req.__("Old password"),
        name: "password",
        input_type: "password",
      },
      {
        label: req.__("New password"),
        name: "new_password",
        input_type: "password",
        validator: (pw) => User.unacceptable_password_reason(pw),
      },
    ],
  });
const setLanguageForm = (req, user) =>
  form(
    {
      action: `/auth/setlanguage/`,
      method: "post",
    },
    csrfField(req.csrfToken()),
    select(
      { name: "locale", onchange: "form.submit()" },
      Object.entries(available_languages).map(([locale, language]) =>
        option(
          {
            value: locale,
            ...(user && user.language === locale && { selected: true }),
          },
          language
        )
      )
    )
  );

const userSettings = async ({ req, res, pwform, user }) => {
  let usersets;
  const user_settings_form = getState().getConfig("user_settings_form", "");
  if (user_settings_form) {
    const view = await View.findOne({ name: user_settings_form });
    if (view) {
      usersets = await view.run({ id: user.id }, { req, res });
    }
  }

  return {
    above: [
      {
        type: "breadcrumbs",
        crumbs: [{ text: req.__("User") }, { text: req.__("Settings") }],
      },
      {
        type: "card",
        title: req.__("User"),
        contents: table(
          tbody(
            tr(
              th(req.__("Email: ")),
              td(a({ href: "mailto:" + req.user.email }, req.user.email))
            ),
            tr(th(req.__("Language: ")), td(setLanguageForm(req, user)))
          )
        ),
      },
      ...(usersets
        ? [
            {
              type: "card",
              title: req.__("User Settings"),
              contents: usersets,
            },
          ]
        : []),
      {
        type: "card",
        title: req.__("Change password"),
        contents: renderForm(pwform, req.csrfToken()),
      },
    ],
  };
};
/**
 * Set language
 */
router.post(
  "/setlanguage",
  setTenant,
  loggedIn,
  error_catcher(async (req, res) => {
    const u = await User.findOne({ id: req.user.id });
    const newlang = available_languages[req.body.locale];
    if (newlang && u) {
      await u.set_language(req.body.locale);
      req.login(
        {
          email: u.email,
          id: u.id,
          role_id: u.role_id,
          language: req.body.locale,
          tenant: db.getTenantSchema(),
        },
        function (err) {
          if (!err) {
            req.flash("success", req.__("Language changed to %s", newlang));
            res.redirect("/auth/settings");
          } else {
            req.flash("danger", err);
            res.redirect("/auth/settings");
          }
        }
      );
    } else {
      req.flash("danger", req.__("Language not found"));
      res.redirect("/auth/settings");
    }
  })
);
router.get(
  "/settings",
  setTenant,
  loggedIn,
  error_catcher(async (req, res) => {
    const user = await User.findOne({ id: req.user.id });
    res.sendWrap(
      req.__("User settings"),
      await userSettings({ req, res, pwform: changPwForm(req), user })
    );
  })
);
/**
 * Define set email form for user
 * @param req
 * @returns {Form}
 */
const setEmailForm = (req) =>
  new Form({
    action: "/auth/set-email",
    blurb: req.__("Please enter your email address"),
    fields: [
      {
        name: "email",
        label: req.__("Email"),
        type: "String",
        attributes: {
          input_type: "email",
        },
        required: true,
      },
    ],
  });
/**
 * Render form for set email for user
 */
router.get(
  "/set-email",
  setTenant,
  error_catcher(async (req, res) => {
    res.sendWrap(
      req.__("Set Email"),
      renderForm(setEmailForm(req), req.csrfToken())
    );
  })
);
/**
 * Execute set email for user
 */
router.post(
  "/set-email",
  setTenant,
  error_catcher(async (req, res) => {
    const form = setEmailForm(req);
    form.validate(req.body);
    if (form.hasErrors || !req.user || !req.user.id) {
      res.sendWrap(req.__("Set Email"), renderForm(form, req.csrfToken()));
      return;
    }
    const existing = await User.findOne({ email: form.values.email });
    if (existing) {
      form.hasErrors = true;
      form.errors.email = req.__(
        "A user with this email address already exists"
      );
      res.sendWrap(req.__("Set Email"), renderForm(form, req.csrfToken()));
      return;
    }

    const u = await User.findOne({ id: req.user.id });
    await u.update({ email: form.values.email });
    u.email = form.values.email;
    req.login(
      {
        email: u.email,
        id: u.id,
        role_id: u.role_id,
        tenant: db.getTenantSchema(),
      },
      function (err) {
        if (!err) {
          Trigger.emitEvent("Login", null, u);
          req.flash("success", req.__("Welcome, %s!", u.email));
          res.redirect("/");
        } else {
          req.flash("danger", err);
          res.redirect("/");
        }
      }
    );
  })
);
/**
 * Execute Change Password for User
 */
router.post(
  "/settings",
  setTenant,
  loggedIn,
  error_catcher(async (req, res) => {
    const user = await User.findOne({ id: req.user.id });
    if (req.body.new_password) {
      const pwform = changPwForm(req);

      pwform.fields[0].validator = (oldpw) => {
        const cmp = user.checkPassword(oldpw);
        if (cmp) return true;
        else return req.__("Password does not match");
      };

      pwform.validate(req.body);

      if (pwform.hasErrors) {
        res.sendWrap(
          req.__("User settings"),
          await userSettings({ req, res, pwform, user })
        );
      } else {
        await user.changePasswordTo(pwform.values.new_password);
        req.flash("success", req.__("Password changed"));
        res.redirect("/auth/settings");
      }
    } else {
      const user_settings_form = getState().getConfig("user_settings_form", "");
      if (user_settings_form) {
        const view = await View.findOne({ name: user_settings_form });
        if (view) {
          await view.runPost({ id: user.id }, req.body, {
            req,
            res,
            redirect: "/auth/settings",
          });
          req.flash("success", req.__("User settings changed"));
        }
      } else {
        res.redirect("/auth/settings");
      }
    }
  })
);

router.all(
  "/verification-flow",
  setTenant,
  loggedIn,
  error_catcher(async (req, res) => {
    const verifier = await (getState().verifier || (() => null))(req.user);
    if (!verifier) {
      res.redirect("/");
      return;
    }
    verifier.action = "/auth/verification-flow";
    const wfres = await verifier.run(req.body || {}, req);
    if (wfres.flash) req.flash(wfres.flash[0], wfres.flash[1]);
    if (wfres.renderForm) {
      res.sendWrap(
        req.__(`Account verification`),
        renderForm(wfres.renderForm, req.csrfToken())
      );
      return;
    }
    if (wfres.verified === true) {
      const user = await User.findOne({ id: req.user.id });
      await user.set_to_verified();
      req.flash("success", req.__("User verified"));
      user.relogin(req);
    }
    if (wfres.verified === false) {
      req.flash("danger", req.__("User verification failed"));
      res.redirect(wfres.redirect || "/auth/verification-flow");
      return;
    }
    res.redirect(wfres.redirect || "/");
  })
);
